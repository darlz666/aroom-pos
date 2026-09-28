import "server-only";
import type { PrismaClient } from "../../generated/prisma/client";
import {
  convertQuantity,
  InventoryError,
  inventoryId,
  validateRecipeReferences,
} from "./domain";
import {
  menuCreateFingerprint,
  menuCreateInput,
  menuDeleteFingerprint,
  menuDeleteInput,
  recipeFingerprint,
  recipeSaveInput,
} from "./recipe-domain";
import {
  withRecipeAccess,
  withRecipeAdminAccess,
  type RecipeActor,
} from "./recipe-authorization";
import { readRecipe } from "./service";
import { ingredientHpp, rupiahAmount } from "./costing";

export function listRecipeOptions(db: PrismaClient, actor: RecipeActor) {
  return withRecipeAccess(db, actor, false, async tx => ({
    categories: await tx.category.findMany({
      where: {
        active: true,
      },
      orderBy: [
        { displayOrder: "asc" },
        { name: "asc" },
        { id: "asc" },
      ],
      select: {
        id: true,
        name: true,
      },
    }),

    products: await tx.product.findMany({
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        active: true,
        available: true,
        recipe: {
          select: {
            id: true,
          },
        },
      },
    }),

    // Costing access does not expose receiving history or grant inventory access.
    ingredients: (
      await tx.ingredient.findMany({
        orderBy: [{ name: "asc" }, { id: "asc" }],
        select: {
          id: true,
          name: true,
          baseUnit: true,
          active: true,
          weightedAverageUnitCostMicros: true,
        },
      })
    ).map(row => ({
      ...row,
      weightedAverageUnitCostMicros:
        row.weightedAverageUnitCostMicros?.toString() ?? null,
    })),
  }));
}

export function getRecipe(db: PrismaClient, actor: RecipeActor, productId: unknown) {
  return withRecipeAccess(db, actor, false, tx => readRecipe(tx, inventoryId(productId)));
}

export function deleteMenu(db: PrismaClient, actor: RecipeActor, input: unknown) {
  return withRecipeAdminAccess(db, actor, async tx => {
    const request = menuDeleteInput(input);
    const fingerprint = menuDeleteFingerprint(actor.id, request);
    // Share the menu mutation key lock with creation; AuditLog is the durable receipt.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${request.idempotencyKey}, 733))`;
    const saved = await tx.auditLog.findUnique({ where: { id: request.idempotencyKey } });
    if (saved) {
      const details = saved.details as { fingerprint?: string; productId?: string; outcome?: string } | null;
      if (saved.actorId !== actor.id || saved.entityType !== "Product" || saved.entityId !== request.productId
        || details?.fingerprint !== fingerprint || details.productId !== request.productId
        || (details.outcome !== "DELETED" && details.outcome !== "ARCHIVED")
        || saved.action !== (details.outcome === "DELETED" ? "MENU_DELETED" : "MENU_ARCHIVED")) {
        throw new InventoryError("IDEMPOTENCY_CONFLICT");
      }
      // Replay precedes lookup: a physically deleted product no longer exists.
      return { productId: request.productId, outcome: details.outcome, replayed: true };
    }

    // Serialize recipe saves/deletes and block new OrderItem FK references until commit.
    await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${request.productId}::uuid FOR UPDATE`;
    const product = await tx.product.findUnique({ where: { id: request.productId },
      select: { id: true, name: true, categoryId: true, price: true, active: true, available: true, recipe: { select: { id: true } } } });
    if (!product) throw new InventoryError("PRODUCT_NOT_FOUND");
    // Any order counts, including unpaid and cancelled orders.
    const history = await tx.orderItem.findFirst({ where: { productId: product.id }, select: { id: true } });
    const outcome = history ? "ARCHIVED" as const : "DELETED" as const;
    const changed = !history || product.active || product.available;
    let deletedRecipeItems = 0;
    if (history) {
      if (changed) await tx.product.update({ where: { id: product.id }, data: { active: false, available: false } });
    } else {
      if (product.recipe) {
        deletedRecipeItems = (await tx.recipeItem.deleteMany({ where: { recipeId: product.recipe.id } })).count;
        await tx.recipe.delete({ where: { id: product.recipe.id } });
      }
      await tx.product.delete({ where: { id: product.id } });
    }
    await tx.auditLog.create({ data: {
      id: request.idempotencyKey, actorId: actor.id,
      action: history ? "MENU_ARCHIVED" : "MENU_DELETED", entityType: "Product", entityId: product.id,
      details: { fingerprint, productId: product.id, outcome, changed,
        name: product.name, categoryId: product.categoryId, price: product.price,
        recipeId: product.recipe?.id ?? null, deletedRecipeItems,
        before: { active: product.active, available: product.available },
        after: history ? { active: false, available: false } : null },
    } });
    return { productId: product.id, outcome, replayed: false };
  });
}

export function createMenu(
  db: PrismaClient,
  actor: RecipeActor,
  input: unknown
) {
  return withRecipeAdminAccess(db, actor, async tx => {
    const request = menuCreateInput(input);
    const fingerprint = menuCreateFingerprint(actor.id, request);

    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${request.idempotencyKey}, 733)
      )
    `;

    const saved = await tx.auditLog.findUnique({
      where: { id: request.idempotencyKey },
    });

    if (saved) {
      const details = saved.details as {
        fingerprint?: string;
        productId?: string;
        recipeId?: string;
      } | null;

      if (
        saved.actorId !== actor.id ||
        saved.entityType !== "Product" ||
        saved.action !== "MENU_CREATED" ||
        details?.fingerprint !== fingerprint ||
        details.productId !== saved.entityId ||
        !details.recipeId
      ) {
        throw new InventoryError("IDEMPOTENCY_CONFLICT");
      }

      return {
        productId: details.productId,
        recipeId: details.recipeId,
        replayed: true,
      };
    }

    await tx.$queryRaw`
      SELECT id
      FROM "Category"
      WHERE id = ${request.categoryId}::uuid
      FOR SHARE
    `;

    const category = await tx.category.findUnique({
      where: { id: request.categoryId },
      select: {
        id: true,
        active: true,
      },
    });

    if (!category?.active) {
      throw new InventoryError("INVALID_INPUT");
    }

    const normalizedItems = [];

    for (const item of request.items) {
      await tx.$queryRaw`
        SELECT id
        FROM "Ingredient"
        WHERE id = ${item.ingredientId}::uuid
        FOR SHARE
      `;

      const ingredient = await tx.ingredient.findUnique({
        where: { id: item.ingredientId },
        select: {
          id: true,
          active: true,
          baseUnit: true,
          weightedAverageUnitCostMicros: true,
        },
      });

      if (!ingredient) {
        throw new InventoryError("INGREDIENT_NOT_FOUND");
      }

      if (!ingredient.active) {
        throw new InventoryError("INGREDIENT_INACTIVE");
      }

      normalizedItems.push({
        ingredientId: ingredient.id,
        quantity: convertQuantity(
          item.quantity.toFixed(),
          item.unit,
          ingredient.baseUnit
        ),
        unit: ingredient.baseUnit,
        weightedAverageUnitCostMicros:
          ingredient.weightedAverageUnitCostMicros,
      });
    }

    let hpp = BigInt(0);

    for (const item of normalizedItems) {
      if (item.weightedAverageUnitCostMicros !== null) {
        hpp += BigInt(
          ingredientHpp(
            item.quantity.toFixed(),
            item.weightedAverageUnitCostMicros
          )
        );
      }
    }

    // Keep the same cost boundaries used by ordinary recipe saves.
    rupiahAmount(hpp);

    const product = await tx.product.create({
      data: {
        categoryId: category.id,
        name: request.name,
        price: request.price,
        active: true,
        available: true,
      },
    });

    const recipe = await tx.recipe.create({
      data: {
        productId: product.id,
        items: {
          create: normalizedItems.map(item => ({
            ingredientId: item.ingredientId,
            quantity: item.quantity,
            unit: item.unit,
          })),
        },
      },
    });

    await tx.auditLog.create({
      data: {
        id: request.idempotencyKey,
        actorId: actor.id,
        action: "MENU_CREATED",
        entityType: "Product",
        entityId: product.id,
        details: {
          fingerprint,
          productId: product.id,
          recipeId: recipe.id,
          name: product.name,
          categoryId: product.categoryId,
          price: product.price,
        },
      },
    });

    return {
      productId: product.id,
      recipeId: recipe.id,
      replayed: false,
    };
  });
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
