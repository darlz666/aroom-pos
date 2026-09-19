import "server-only";
import type { PrismaClient } from "../../generated/prisma/client";
import { InventoryError, inventoryId, validateRecipeReferences } from "./domain";
import { recipeFingerprint, recipeSaveInput } from "./recipe-domain";
import { withRecipeAccess, type RecipeActor } from "./recipe-authorization";
import { readRecipe } from "./service";
import { ingredientHpp, rupiahAmount } from "./costing";

export function listRecipeOptions(db: PrismaClient, actor: RecipeActor) {
  return withRecipeAccess(db, actor, false, async tx => ({
    products: await tx.product.findMany({ orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true, active: true, available: true, recipe: { select: { id: true } } } }),
    // Costing access does not expose receiving history or grant inventory access.
    ingredients: (await tx.ingredient.findMany({ orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true, baseUnit: true, active: true, weightedAverageUnitCostMicros: true },
    })).map(row => ({ ...row, weightedAverageUnitCostMicros: row.weightedAverageUnitCostMicros?.toString() ?? null })),
  }));
}

export function getRecipe(db: PrismaClient, actor: RecipeActor, productId: unknown) {
  return withRecipeAccess(db, actor, false, tx => readRecipe(tx, inventoryId(productId)));
}

/** Product lock covers both absent recipes and edits. AuditLog is also the
 * durable save receipt; no parallel recipe/history/idempotency model is needed. */
export function saveRecipe(db: PrismaClient, actor: RecipeActor, input: unknown) {
  return withRecipeAccess(db, actor, true, async tx => {
    const request = recipeSaveInput(input);
    const fingerprint = recipeFingerprint(actor.id, request);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${request.idempotencyKey}, 732))`;
    const saved = await tx.auditLog.findUnique({ where: { id: request.idempotencyKey } });
    if (saved) {
      const details = saved.details as { fingerprint?: string; productId: string; revision: number } | null;
      if (saved.actorId !== actor.id || saved.entityType !== "Recipe" || saved.action !== "RECIPE_SAVED"
        || details?.fingerprint !== fingerprint) throw new InventoryError("IDEMPOTENCY_CONFLICT");
      return { recipeId: saved.entityId, productId: details.productId, revision: details.revision, replayed: true };
    }
    await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${request.productId}::uuid FOR UPDATE`;
    const product = await tx.product.findUnique({ where: { id: request.productId }, select: { id: true } });
    if (!product) throw new InventoryError("PRODUCT_NOT_FOUND");
    const before = await tx.recipe.findUnique({ where: { productId: request.productId }, include: { items: { orderBy: { ingredientId: "asc" } } } });
    if ((before?.revision ?? null) !== request.expectedRevision) throw new InventoryError("STALE_RECIPE");
    const ingredients = [];
    for (const item of request.items) {
      await tx.$queryRaw`SELECT id FROM "Ingredient" WHERE id = ${item.ingredientId}::uuid FOR SHARE`;
      const ingredient = await tx.ingredient.findUnique({ where: { id: item.ingredientId } });
      if (!ingredient) throw new InventoryError("INGREDIENT_NOT_FOUND");
      const existing = before?.items.find(line => line.ingredientId === ingredient.id);
      if (!ingredient.active && (!existing || !existing.quantity.equals(item.quantity) || existing.unit !== item.unit)) {
        throw new InventoryError("INGREDIENT_INACTIVE");
      }
      ingredients.push(ingredient);
    }
    const normalized = validateRecipeReferences(request, product, ingredients);
    // Validate the current estimate using the same 7E fixed-point boundaries.
    // Unknown costs remain unknown and never prevent saving a recipe definition.
    let hpp = BigInt(0);
    for (const item of normalized.items) {
      const cost = ingredients.find(ingredient => ingredient.id === item.ingredientId)!.weightedAverageUnitCostMicros;
      if (cost !== null) hpp += BigInt(ingredientHpp(item.quantity.toFixed(), cost));
    }
    rupiahAmount(hpp);
    const snapshot = (items: typeof normalized.items) => items.map(item => ({ ingredientId: item.ingredientId, quantity: item.quantity.toFixed(), unit: item.unit }));
    const previous = before ? snapshot(before.items) : null;
    const next = snapshot(normalized.items);
    const changed = JSON.stringify(previous) !== JSON.stringify(next);
    let recipe = before;
    if (!recipe) {
      recipe = await tx.recipe.create({ data: { productId: product.id, items: { create: normalized.items } }, include: { items: true } });
    } else if (changed) {
      await tx.recipeItem.deleteMany({ where: { recipeId: recipe.id } });
      recipe = await tx.recipe.update({ where: { id: recipe.id }, data: { revision: { increment: 1 }, items: { create: normalized.items } }, include: { items: true } });
    }
    await tx.auditLog.create({ data: { id: request.idempotencyKey, actorId: actor.id, action: "RECIPE_SAVED", entityType: "Recipe", entityId: recipe.id,
      details: { fingerprint, productId: product.id, revision: recipe.revision, changed, before: previous, after: next } } });
    return { recipeId: recipe.id, productId: product.id, revision: recipe.revision, replayed: false };
  });
}
