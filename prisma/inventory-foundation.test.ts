import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { convertQuantity, ingredientInput, recipeInput, supplierInput, validateRecipeReferences } from "../src/lib/inventory/domain";

test("inventory PostgreSQL foundation (all fixtures rolled back)", async t => {
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.ok(process.env.DATABASE_URL);
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/aroom_access_test_/, "Use the existing disposable database test runner");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  const rollback = new Error("rollback inventory fixtures");
  try {
    await assert.rejects(db.$transaction(async tx => {
      const actor = await tx.user.create({ data: { name: "Inventory fixture", loginIdentifier: randomUUID(), passwordHash: "unused", role: "ADMIN" } });
      const category = await tx.category.create({ data: { name: "Inventory fixture" } });
      const oatmilk = await tx.ingredient.create({ data: ingredientInput({ name: `Oatmilk ${randomUUID()}`, baseUnit: "L", minimumStock: 1 }) });
      const sugar = await tx.ingredient.create({ data: ingredientInput({ name: `Sugar ${randomUUID()}`, baseUnit: "kg" }) });
      const supplier = await tx.supplier.create({ data: supplierInput({ name: "Milk distributor", active: false }) });
      const product = await tx.product.create({ data: { categoryId: category.id, name: "Aroom Single Shot", price: 22000 } });
      const recipe = await tx.recipe.create({ data: { productId: product.id } });
      const rejected = async (name: string, operation: () => Promise<unknown>, expected: string) => {
        await t.test(name, async () => {
          await tx.$executeRawUnsafe("SAVEPOINT invalid_inventory_row");
          try {
            await assert.rejects(operation(), (error: unknown) => {
              assert.ok(error && typeof error === "object");
              const failure = error as { code?: string; cause?: { originalCode?: string }; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } } };
              const sqlState = failure.cause?.originalCode ?? failure.meta?.driverAdapterError?.cause?.originalCode ?? failure.meta?.code;
              assert.equal(expected.startsWith("P") ? failure.code : sqlState, expected);
              return true;
            });
          } finally { await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT invalid_inventory_row"); }
        });
      };

      await t.test("zero stock and unknown cost defaults; supplier metadata and active flags", async () => {
        assert.equal(oatmilk.currentStock.toString(), "0"); assert.equal(oatmilk.minimumStock.toString(), "1000");
        assert.equal(oatmilk.baseUnit, "ml"); assert.equal(oatmilk.weightedAverageUnitCostMicros, null); assert.equal(oatmilk.active, true);
        assert.equal(sugar.baseUnit, "g"); assert.equal(supplier.active, false); assert.equal(supplier.phone, null);
        const updated = await tx.supplier.update({ where: { id: supplier.id }, data: { active: true } });
        assert.equal(updated.active, true);
        const cost = await tx.ingredient.update({ where: { id: oatmilk.id }, data: { weightedAverageUnitCostMicros: BigInt(25_000_000) } });
        assert.equal(cost.weightedAverageUnitCostMicros, BigInt(25_000_000));
        assert.equal((await tx.product.findUniqueOrThrow({ where: { id: product.id } })).price, 22000);
      });

      await t.test("three existing POS products share one 12000 ml balance; recipes do not consume it", async () => {
        // Test fixture only: no stock-in service or automatic movement writer.
        await tx.ingredient.update({ where: { id: oatmilk.id }, data: { currentStock: convertQuantity(12, "L", "ml") } });
        for (const [index, name, amount] of [[0, "Aroom Single Shot", 100], [1, "Aroom Double Shot", 150], [2, "Matcha Latte", 120]] as const) {
          const target = index === 0 ? product : await tx.product.create({ data: { categoryId: category.id, name, price: 25000 } });
          const targetRecipe = index === 0 ? recipe : await tx.recipe.create({ data: { productId: target.id } });
          const input = recipeInput({ productId: target.id, items: [{ ingredientId: oatmilk.id, quantity: amount, unit: "ml" }] });
          const references = await tx.ingredient.findMany({ where: { id: { in: input.items.map(item => item.ingredientId) } } });
          const validated = validateRecipeReferences(input, await tx.product.findUnique({ where: { id: input.productId } }), references);
          await tx.recipeItem.createMany({ data: validated.items.map(item => ({ ...item, recipeId: targetRecipe.id })) });
        }
        const shared = await tx.ingredient.findUniqueOrThrow({ where: { id: oatmilk.id }, include: { recipeItems: true } });
        assert.equal(shared.currentStock.toString(), "12000"); assert.equal(shared.recipeItems.length, 3);
        assert.deepEqual(shared.recipeItems.map(item => item.quantity.toNumber()).sort((a, b) => a - b), [100, 120, 150]);
        assert.equal(await tx.stockMovement.count({ where: { ingredientId: oatmilk.id } }), 0);
        await tx.recipeItem.create({ data: { recipeId: recipe.id, ingredientId: sugar.id, quantity: "12.125", unit: "g" } });
        assert.equal(await tx.recipeItem.count({ where: { recipeId: recipe.id } }), 2);
        await tx.ingredient.update({ where: { id: oatmilk.id }, data: { name: `Renamed ${randomUUID()}`, active: false } });
        assert.equal(await tx.recipeItem.count({ where: { ingredientId: oatmilk.id } }), 3);
        assert.equal((await tx.product.findUniqueOrThrow({ where: { id: product.id } })).available, true);
      });

      const current = await tx.ingredient.findUniqueOrThrow({ where: { id: oatmilk.id } });
      await rejected("case/space duplicate ingredient rejected, including inactive ingredients", () => tx.ingredient.create({ data: { name: ` ${current.name.toUpperCase()} `, baseUnit: "ml" } }), "P2002");
      await rejected("blank ingredient name", () => tx.$executeRaw`UPDATE "Ingredient" SET name = ' ' WHERE id = ${oatmilk.id}::uuid`, "23514");
      await rejected("blank supplier name", () => tx.$executeRaw`UPDATE "Supplier" SET name = '' WHERE id = ${supplier.id}::uuid`, "23514");
      await rejected("negative stock", () => tx.$executeRaw`UPDATE "Ingredient" SET "currentStock" = -1 WHERE id = ${oatmilk.id}::uuid`, "23514");
      await rejected("NaN stock", () => tx.$executeRaw`UPDATE "Ingredient" SET "currentStock" = 'NaN' WHERE id = ${oatmilk.id}::uuid`, "23514");
      await rejected("negative minimum", () => tx.$executeRaw`UPDATE "Ingredient" SET "minimumStock" = -1 WHERE id = ${oatmilk.id}::uuid`, "23514");
      await rejected("negative cost", () => tx.$executeRaw`UPDATE "Ingredient" SET "weightedAverageUnitCostMicros" = -1 WHERE id = ${oatmilk.id}::uuid`, "23514");
      await rejected("legacy cost frozen", () => tx.ingredient.update({ where: { id: oatmilk.id }, data: { legacyUnitCost: 25 } }), "23514");
      await rejected("unknown unit", () => tx.$executeRaw`UPDATE "Ingredient" SET "baseUnit" = 'bottle' WHERE id = ${oatmilk.id}::uuid`, "22P02");
      await rejected("canonical base unit required at rest", () => tx.ingredient.create({ data: { name: randomUUID(), baseUnit: "L" } }), "23514");
      await rejected("base unit cannot reinterpret balances/cost/history", () => tx.$executeRaw`UPDATE "Ingredient" SET "baseUnit" = 'g' WHERE id = ${oatmilk.id}::uuid`, "23514");
      await rejected("one recipe per POS product", () => tx.recipe.create({ data: { productId: product.id } }), "P2002");
      await rejected("recipe product must exist", () => tx.recipe.create({ data: { productId: randomUUID() } }), "P2003");
      await rejected("ingredient may appear once per recipe", () => tx.recipeItem.create({ data: { recipeId: recipe.id, ingredientId: oatmilk.id, quantity: 100, unit: "ml" } }), "P2002");
      const item = await tx.recipeItem.findFirstOrThrow({ where: { recipeId: recipe.id, ingredientId: oatmilk.id } });
      await rejected("recipe must exist", () => tx.recipeItem.update({ where: { id: item.id }, data: { recipeId: randomUUID() } }), "P2003");
      await rejected("ingredient must exist", () => tx.recipeItem.update({ where: { id: item.id }, data: { ingredientId: randomUUID() } }), "P2003");
      await rejected("recipe unit must match canonical ingredient unit", () => tx.recipeItem.update({ where: { id: item.id }, data: { unit: "g" } }), "P2003");
      await rejected("zero recipe quantity", () => tx.$executeRaw`UPDATE "RecipeItem" SET quantity = 0 WHERE id = ${item.id}::uuid`, "23514");
      await rejected("negative recipe quantity", () => tx.$executeRaw`UPDATE "RecipeItem" SET quantity = -1 WHERE id = ${item.id}::uuid`, "23514");
      await rejected("referenced ingredient cannot be deleted", () => tx.ingredient.delete({ where: { id: oatmilk.id } }), "P2003");
      await rejected("referenced product cannot be deleted", () => tx.product.delete({ where: { id: product.id } }), "P2003");

      const movementData = { ingredientId: oatmilk.id, type: "PURCHASE" as const, quantity: "12000", unit: "ml" as const, stockAfter: "12000", actorId: actor.id };
      const movement = await tx.stockMovement.create({ data: movementData });
      await t.test("non-sale movement types support optional actor/source without balance mutation", async () => {
        for (const type of ["ADJUSTMENT_IN", "ADJUSTMENT_OUT"] as const) {
          const entry = await tx.stockMovement.create({ data: { ...movementData, type, actorId: null, sourceType: "Fixture", sourceId: randomUUID() } });
          assert.equal(entry.type, type); assert.equal(entry.actorId, null);
        }
        assert.equal((await tx.ingredient.findUniqueOrThrow({ where: { id: oatmilk.id } })).currentStock.toString(), "12000");
      });
      await rejected("7G sale movements require payment identity", () => tx.stockMovement.create({ data: { ...movementData, type: "SALE_CONSUMPTION" } }), "23514");
      await rejected("movement quantity must be positive", () => tx.stockMovement.create({ data: { ...movementData, quantity: 0 } }), "23514");
      await rejected("movement resulting stock cannot be negative", () => tx.stockMovement.create({ data: { ...movementData, stockAfter: -1 } }), "23514");
      await rejected("movement unit must match ingredient", () => tx.stockMovement.create({ data: { ...movementData, unit: "pcs" } }), "P2003");
      await rejected("movement actor must exist", () => tx.stockMovement.create({ data: { ...movementData, actorId: randomUUID() } }), "P2003");
      await rejected("movement source fields are paired", () => tx.stockMovement.create({ data: { ...movementData, sourceType: "Fixture" } }), "23514");
      await rejected("movement edits forbidden", () => tx.$executeRaw`UPDATE "StockMovement" SET quantity = 1 WHERE id = ${movement.id}::uuid`, "23514");
      await rejected("movement deletion forbidden", () => tx.$executeRaw`DELETE FROM "StockMovement" WHERE id = ${movement.id}::uuid`, "23514");
      assert.equal((await tx.stockMovement.findUniqueOrThrow({ where: { id: movement.id } })).quantity.toString(), "12000");
      throw rollback;
    }, { timeout: 30_000 }), error => error === rollback);
  } finally { await db.$disconnect(); }
});
