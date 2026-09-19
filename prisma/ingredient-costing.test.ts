import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { createStockIn, createSupplier, getRecipeHpp, getStockIn, listIngredients } from "../src/lib/inventory/service";
import { COST_SCALE, weightedAverageCost } from "../src/lib/inventory/costing";

test("WAC receiving and current HPP PostgreSQL behavior", async t => {
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.ok(process.env.DATABASE_URL);
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/aroom_access_test_/);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  try {
    const actor = await db.user.create({ data: { name: "Costing manager", loginIdentifier: randomUUID(), passwordHash: "unused", role: "STOCK_MANAGEMENT" } });
    const supplier = await createSupplier(db, actor, { name: "Costing supplier" });
    const oat = await db.ingredient.create({ data: { name: `Costing oat ${randomUUID()}`, baseUnit: "ml" } });
    const beans = await db.ingredient.create({ data: { name: `Costing beans ${randomUUID()}`, baseUnit: "g" } });
    const category = await db.category.create({ data: { name: "Costing fixtures" } });
    const products = await Promise.all(["100", "150", "120"].map(quantity => db.product.create({ data: {
      name: `Recipe ${quantity}`, price: 22000, categoryId: category.id,
      recipe: { create: { items: { create: { ingredientId: oat.id, quantity, unit: "ml" } } } },
    } })));
    const payload = (items: unknown[]) => ({ idempotencyKey: randomUUID(), supplierId: supplier.id,
      receivedAt: "2026-09-18T09:00:00+07:00", items });
    const read = (id: string) => db.ingredient.findUniqueOrThrow({ where: { id } });

    await t.test("initial receiving and mixed ingredients set independent costs", async () => {
      const missing = await getRecipeHpp(db, actor, products[0].id);
      assert.equal(missing.available, false); assert.equal(missing.total, null);
      assert.deepEqual(missing.missingCostIngredientIds, [oat.id]);
      await createStockIn(db, actor, payload([
        { ingredientId: oat.id, quantity: "5", unit: "L", purchaseUnitCost: 30000 },
        { ingredientId: beans.id, quantity: "1", unit: "kg", purchaseUnitCost: 100000 },
      ]));
      assert.equal((await read(oat.id)).weightedAverageUnitCostMicros, BigInt(30_000_000));
      assert.equal((await read(beans.id)).weightedAverageUnitCostMicros, BigInt(100_000_000));
    });

    await t.test("business example, shared recipes, lost-response replay and immutable purchase evidence", async () => {
      const request = payload([{ ingredientId: oat.id, quantity: "12", unit: "L", purchaseUnitCost: 35000 }]);
      const receipt = await createStockIn(db, actor, request);
      assert.equal((await read(oat.id)).currentStock.toFixed(), "17000");
      assert.equal((await read(oat.id)).weightedAverageUnitCostMicros, BigInt(33_529_412));
      const saved = await getStockIn(db, actor, receipt.id);
      assert.equal(saved.items[0].inputQuantity, "12"); assert.equal(saved.items[0].inputUnit, "L");
      assert.equal(saved.items[0].purchaseUnitCost, 35000); assert.equal(saved.items[0].receivedUnitCostMicros, "35000000");
      assert.equal(saved.items[0].lineTotal, 420000);
      const estimates = await Promise.all(products.map(product => getRecipeHpp(db, actor, product.id)));
      assert.deepEqual(estimates.map(estimate => estimate.total), [3353, 5029, 4024]);
      assert.ok(estimates.every(estimate => estimate.items[0].weightedAverageUnitCostMicros === "33529412"));
      const balanceBefore = await read(oat.id);
      assert.deepEqual(await createStockIn(db, actor, request), { ...receipt, replayed: true });
      assert.deepEqual(await read(oat.id), balanceBefore);
      await assert.rejects(createStockIn(db, actor, { ...request, items: [{ ...request.items[0] as object, purchaseUnitCost: 35001 }] }), { code: "IDEMPOTENCY_CONFLICT" });
      await createStockIn(db, actor, payload([{ ingredientId: oat.id, quantity: "1000", unit: "ml", unitCost: 30 }]));
      assert.equal((await read(oat.id)).weightedAverageUnitCostMicros, BigInt(33_333_334));
      assert.deepEqual(await getStockIn(db, actor, receipt.id), saved);
      assert.equal((await getRecipeHpp(db, actor, products[0].id)).total, 3333);
      assert.equal((await read(oat.id)).currentStock.toFixed(), "18000");
      assert.ok((await db.product.findMany({ where: { id: { in: products.map(p => p.id) } } })).every(p => p.price === 22000 && p.available));
      assert.doesNotThrow(() => JSON.stringify(estimates));
      assert.equal((await listIngredients(db, actor)).find(row => row.id === oat.id)?.weightedAverageUnitCostMicros, "33333334");
    });

    await t.test("simultaneous duplicates update WAC once; distinct overlapping receipts serialize", async () => {
      const a = await db.ingredient.create({ data: { name: randomUUID(), baseUnit: "pcs" } });
      const b = await db.ingredient.create({ data: { name: randomUUID(), baseUnit: "pcs" } });
      const first = payload([{ ingredientId: a.id, quantity: "1", unit: "pcs", purchaseUnitCost: 1 },
        { ingredientId: b.id, quantity: "2", unit: "pcs", purchaseUnitCost: 10 }]);
      const copies = await Promise.all([createStockIn(db, actor, first), createStockIn(db, actor, first)]);
      assert.equal(copies[0].id, copies[1].id); assert.equal(copies.filter(r => r.replayed).length, 1);
      assert.equal((await read(a.id)).currentStock.toFixed(), "1");
      assert.equal((await read(a.id)).weightedAverageUnitCostMicros, COST_SCALE);
      await Promise.all([
        createStockIn(db, actor, payload([{ ingredientId: a.id, quantity: "2", unit: "pcs", purchaseUnitCost: 2 }, { ingredientId: b.id, quantity: "1", unit: "pcs", purchaseUnitCost: 20 }])),
        createStockIn(db, actor, payload([{ ingredientId: b.id, quantity: "3", unit: "pcs", purchaseUnitCost: 30 }, { ingredientId: a.id, quantity: "3", unit: "pcs", purchaseUnitCost: 3 }])),
      ]);
      for (const ingredient of [a, b]) {
        const movements = await db.stockMovement.findMany({ where: { ingredientId: ingredient.id }, orderBy: { stockAfter: "asc" } });
        assert.equal(movements.length, 3);
        let balance = "0", cost: bigint | null = null;
        for (const m of movements) {
          const line = await db.stockInItem.findFirstOrThrow({ where: { stockInId: m.sourceId!, ingredientId: ingredient.id } });
          cost = weightedAverageCost(balance, cost, line.baseQuantity.toFixed(), line.receivedUnitCostMicros!);
          balance = m.stockAfter.toFixed();
        }
        const current = await read(ingredient.id);
        assert.equal(current.currentStock.toFixed(), "6");
        assert.equal(current.weightedAverageUnitCostMicros, cost);
      }
    });

    await t.test("unknown positive stock rejects the whole receipt; HPP does not substitute latest price", async () => {
      const unknown = await db.ingredient.create({ data: { name: randomUUID(), baseUnit: "pcs", currentStock: "1" } });
      const before = await read(oat.id);
      const request = payload([{ ingredientId: oat.id, quantity: "1", unit: "L", purchaseUnitCost: 35000 },
        { ingredientId: unknown.id, quantity: "1", unit: "pcs", purchaseUnitCost: 1 }]);
      await assert.rejects(createStockIn(db, actor, request), { code: "UNKNOWN_INGREDIENT_COST" });
      assert.deepEqual(await read(oat.id), before);
      assert.equal(await db.stockIn.count({ where: { idempotencyKey: request.idempotencyKey } }), 0);
      const recipe = await db.recipe.findUniqueOrThrow({ where: { productId: products[0].id } });
      await db.recipeItem.create({ data: { recipeId: recipe.id, ingredientId: unknown.id, quantity: "1", unit: "pcs" } });
      const hpp = await getRecipeHpp(db, actor, products[0].id);
      assert.equal(hpp.total, null); assert.deepEqual(hpp.missingCostIngredientIds, [unknown.id]);
      assert.deepEqual(await read(oat.id), before);
      assert.equal((await read(unknown.id)).currentStock.toFixed(), "1");
    });

    await t.test("HPP adds rounded contributions; zero stock with known WAC remains costable", async () => {
      const ingredients = await Promise.all([1, 2].map(() => db.ingredient.create({ data: {
        name: randomUUID(), baseUnit: "g", weightedAverageUnitCostMicros: BigInt(500_000),
      } })));
      const product = await db.product.create({ data: { name: randomUUID(), categoryId: category.id, price: 1,
        recipe: { create: { items: { create: ingredients.map(i => ({ ingredientId: i.id, quantity: "1", unit: "g" as const })) } } } } });
      const hpp = await getRecipeHpp(db, actor, product.id);
      assert.equal(hpp.total, 2); assert.deepEqual(hpp.items.map(i => i.hpp), [1, 1]);
      for (const i of ingredients) assert.equal((await read(i.id)).currentStock.toFixed(), "0");
      await assert.rejects(getRecipeHpp(db, actor, randomUUID()), { code: "PRODUCT_NOT_FOUND" });
      const empty = await db.product.create({ data: { name: randomUUID(), categoryId: category.id, price: 1 } });
      await assert.rejects(getRecipeHpp(db, actor, empty.id), { code: "RECIPE_NOT_FOUND" });
    });

    await t.test("server permissions reload roles and active status for HPP", async () => {
      for (const role of ["CASHIER"] as const) {
        const denied = await db.user.create({ data: { name: role, loginIdentifier: randomUUID(), passwordHash: "unused", role } });
        await assert.rejects(getRecipeHpp(db, denied, products[0].id), { code: "FORBIDDEN" });
        await assert.rejects(getRecipeHpp(db, { ...denied, role: "ADMIN" }, products[0].id), { code: "FORBIDDEN" });
      }
      const finance = await db.user.create({ data: { name: "Finance", loginIdentifier: randomUUID(), passwordHash: "unused", role: "FINANCE" } });
      assert.equal((await getRecipeHpp(db, finance, products[1].id)).available, true);
      await assert.rejects(listIngredients(db, finance), { code: "FORBIDDEN" });
      await db.user.update({ where: { id: actor.id }, data: { active: false } });
      await assert.rejects(getRecipeHpp(db, actor, products[0].id), { code: "FORBIDDEN" });
      await db.user.update({ where: { id: actor.id }, data: { active: true, role: "ADMIN" } });
      assert.equal((await getRecipeHpp(db, { ...actor, role: "ADMIN" }, products[1].id)).available, true);
    });
  } finally { await db.$disconnect(); }
});
