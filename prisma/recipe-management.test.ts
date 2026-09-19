import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../src/generated/prisma/client";
import { getRecipe, listRecipeOptions, saveRecipe } from "../src/lib/inventory/recipe-service";
import { createStockIn, createSupplier, getRecipeHpp, listIngredients } from "../src/lib/inventory/service";

test("7F recipe management PostgreSQL integrity, concurrency, authorization and costing", async t => {
  assert.notEqual(process.env.NODE_ENV, "production");
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/aroom_access_test_/);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  try {
    const user = async (role: "ADMIN" | "STOCK_MANAGEMENT" | "FINANCE" | "CASHIER") => db.user.create({ data: { name: role, role, loginIdentifier: randomUUID(), passwordHash: "unused" } });
    const admin = await user("ADMIN"), stock = await user("STOCK_MANAGEMENT"), finance = await user("FINANCE"), cashier = await user("CASHIER");
    const category = await db.category.create({ data: { name: randomUUID() } });
    const product = () => db.product.create({ data: { name: randomUUID(), categoryId: category.id, price: 22000, active: false, available: false } });
    const oat = await db.ingredient.create({ data: { name: randomUUID(), baseUnit: "ml", currentStock: "5000", weightedAverageUnitCostMicros: BigInt(30000000) } });
    const unknown = await db.ingredient.create({ data: { name: randomUUID(), baseUnit: "pcs" } });
    const p = await product();
    const request = (productId = p.id, expectedRevision: number | null = null, quantity = "100") => ({ productId, expectedRevision, idempotencyKey: randomUUID(), items: [{ ingredientId: oat.id, quantity, unit: "ml" }] });
    const savedRequest = request();
    const unchanged = async () => ({ ingredients: await db.ingredient.findMany({ where: { id: { in: [oat.id, unknown.id] } }, orderBy: { id: "asc" } }),
      product: await db.product.findUniqueOrThrow({ where: { id: p.id } }), movements: await db.stockMovement.count(), orders: await db.order.findMany({ include: { items: true, payments: true } }) });
    const original = await unchanged();

    await t.test("inactive/unavailable products accept recipes; repeated concurrent saves commit once", async () => {
      assert.equal((await getRecipe(db, finance, p.id)).recipeId, null);
      const copies = await Promise.all([saveRecipe(db, stock, savedRequest), saveRecipe(db, stock, savedRequest)]);
      assert.equal(copies[0].recipeId, copies[1].recipeId);
      assert.equal(copies.filter(row => row.replayed).length, 1);
      assert.equal(await db.recipe.count({ where: { productId: p.id } }), 1);
      assert.equal(await db.auditLog.count({ where: { id: savedRequest.idempotencyKey } }), 1);
      const detail = await getRecipe(db, finance, p.id);
      assert.equal(detail.revision, 1); assert.equal(detail.total, 3000);
      assert.equal(detail.productActive, false); assert.equal(detail.productAvailable, false);
      assert.deepEqual(await unchanged(), original);
      assert.doesNotMatch(JSON.stringify(await listRecipeOptions(db, finance)), /password|fingerprint|currentStock|price/);
    });
    await t.test("stale editors and racing creates never overwrite; original retries survive later edits", async () => {
      const edits = [request(p.id, 1, "150"), request(p.id, 1, "120")];
      const results = await Promise.allSettled(edits.map(input => saveRecipe(db, admin, input)));
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      const rejected = results.find(r => r.status === "rejected") as PromiseRejectedResult;
      assert.equal(rejected.reason.code, "STALE_RECIPE");
      assert.equal((await getRecipe(db, stock, p.id)).revision, 2);
      const beforeReplay = await getRecipe(db, stock, p.id);
      assert.equal((await saveRecipe(db, stock, savedRequest)).revision, 1);
      assert.deepEqual(await getRecipe(db, stock, p.id), beforeReplay);
      await assert.rejects(saveRecipe(db, stock, { ...savedRequest, items: [{ ...savedRequest.items[0], quantity: "1" }] }), { code: "IDEMPOTENCY_CONFLICT" });
      await assert.rejects(saveRecipe(db, admin, savedRequest), { code: "IDEMPOTENCY_CONFLICT" });
      const fresh = await product();
      const races = await Promise.allSettled([saveRecipe(db, admin, request(fresh.id)), saveRecipe(db, stock, request(fresh.id))]);
      assert.equal(races.filter(r => r.status === "fulfilled").length, 1);
      assert.equal(await db.recipe.count({ where: { productId: fresh.id } }), 1);
      const noChange = { ...request(p.id, 2), items: beforeReplay.items.map(i => ({ ingredientId: i.ingredientId, quantity: i.quantity, unit: i.unit })) };
      assert.equal((await saveRecipe(db, admin, noChange)).revision, 2);
      assert.equal((await db.auditLog.findUniqueOrThrow({ where: { id: noChange.idempotencyKey } })).details &&
        ((await db.auditLog.findUniqueOrThrow({ where: { id: noChange.idempotencyKey } })).details as { changed: boolean }).changed, false);
      assert.equal((await saveRecipe(db, admin, noChange)).replayed, true);
      assert.deepEqual(await unchanged(), original);
    });
    await t.test("invalid references, units, precision and client money do not write", async () => {
      const before = await getRecipe(db, stock, p.id), count = await db.auditLog.count();
      for (const [patch, code] of [
        [{ productId: randomUUID() }, "PRODUCT_NOT_FOUND"],
        [{ items: [{ ingredientId: randomUUID(), quantity: "1", unit: "ml" }] }, "INGREDIENT_NOT_FOUND"],
        [{ items: [{ ingredientId: oat.id, quantity: "1", unit: "g" }] }, "INCOMPATIBLE_UNIT"],
        [{ items: [{ ingredientId: oat.id, quantity: "0.0001", unit: "ml" }] }, "INVALID_QUANTITY"],
        [{ price: 10 }, "INVALID_INPUT"], [{ total: 0 }, "INVALID_INPUT"],
        [{ items: [{ ingredientId: oat.id, quantity: "999999999999999", unit: "ml" }] }, "INVALID_COST"],
      ] as const) await assert.rejects(saveRecipe(db, stock, { ...request(p.id, 2), ...patch }), { code });
      assert.deepEqual(await getRecipe(db, stock, p.id), before); assert.equal(await db.auditLog.count(), count);
    });
    await t.test("inactive ingredients remain readable and replaceable, but cannot be added or changed", async () => {
      await db.ingredient.update({ where: { id: oat.id }, data: { active: false } });
      const current = await getRecipe(db, finance, p.id);
      assert.equal(current.items[0].active, false);
      await assert.rejects(saveRecipe(db, admin, request((await product()).id)), { code: "INGREDIENT_INACTIVE" });
      await assert.rejects(saveRecipe(db, admin, request(p.id, 2, "999")), { code: "INGREDIENT_INACTIVE" });
      const unchangedItems = current.items.map(i => ({ ingredientId: i.ingredientId, quantity: i.quantity, unit: i.unit }));
      await saveRecipe(db, admin, { ...request(p.id, 2), items: unchangedItems });
      await saveRecipe(db, stock, { ...request(p.id, 2), items: [{ ingredientId: unknown.id, quantity: "0.5", unit: "pcs" }] });
      const missing = await getRecipe(db, finance, p.id);
      assert.equal(missing.revision, 3); assert.equal(missing.total, null); assert.equal(missing.available, false);
      assert.deepEqual(missing.missingCostIngredientIds, [unknown.id]);
      await db.ingredient.update({ where: { id: oat.id }, data: { active: true } });
    });
    await t.test("audit or item write failure rolls back creation, replacement and revision; exact retry succeeds", async () => {
      for (const failedModel of ["recipe", "auditLog"] as const) {
        const broken = { $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => db.$transaction(tx => fn(new Proxy(tx, {
          get(target, key) {
            if (key !== failedModel) return Reflect.get(target, key);
            return new Proxy(target[failedModel], { get(model, method) {
              if (["create", "update"].includes(String(method))) return async () => { throw new Error("injected recipe failure"); };
              return Reflect.get(model, method);
            } });
          },
        }))) } as unknown as PrismaClient;
        const current = await getRecipe(db, admin, p.id), edit = request(p.id, current.revision, "80");
        await assert.rejects(saveRecipe(broken, admin, edit), /injected recipe failure/);
        assert.deepEqual(await getRecipe(db, admin, p.id), current);
        assert.equal(await db.auditLog.count({ where: { id: edit.idempotencyKey } }), 0);
        await saveRecipe(db, admin, edit);
        const fresh = await product(), create = request(fresh.id);
        await assert.rejects(saveRecipe(broken, stock, create), /injected recipe failure/);
        assert.equal(await db.recipe.count({ where: { productId: fresh.id } }), 0);
        await saveRecipe(db, stock, create);
      }
    });
    await t.test("current WAC updates shared recipes without allocating stock or altering historical evidence", async () => {
      const second = await product();
      await saveRecipe(db, stock, request(second.id, null, "100"));
      const supplier = await createSupplier(db, stock, { name: randomUUID() });
      const beforeProduct = await db.product.findUniqueOrThrow({ where: { id: p.id } });
      const beforeRecipe = await db.recipe.findUniqueOrThrow({ where: { productId: p.id }, include: { items: true } });
      const receipt = await createStockIn(db, stock, { idempotencyKey: randomUUID(), supplierId: supplier.id, receivedAt: "2026-09-19T10:00:00+07:00",
        items: [{ ingredientId: oat.id, quantity: "12", unit: "L", purchaseUnitCost: 35000 }] });
      assert.equal(receipt.items[0].lineTotal, 420000);
      assert.equal((await getRecipe(db, finance, second.id)).total, 3353);
      assert.equal((await db.ingredient.findUniqueOrThrow({ where: { id: oat.id } })).currentStock.toFixed(), "17000");
      assert.deepEqual(await db.product.findUniqueOrThrow({ where: { id: p.id } }), beforeProduct);
      assert.deepEqual(await db.recipe.findUniqueOrThrow({ where: { productId: p.id }, include: { items: true } }), beforeRecipe);
      assert.deepEqual(await db.order.findMany({ include: { items: true, payments: true } }), original.orders);
      const audits = await db.auditLog.findMany({ where: { entityType: "Recipe" } });
      assert.ok(audits.length); assert.doesNotMatch(JSON.stringify(audits), /password|credential/);
    });
    await t.test("overflow remains editable, unknown differs from known zero, and revision has a DB check", async () => {
      const free = await db.ingredient.create({ data: { name: randomUUID(), baseUnit: "pcs", weightedAverageUnitCostMicros: BigInt(0) } });
      const fresh = await product();
      await saveRecipe(db, admin, { ...request(fresh.id), items: [{ ingredientId: free.id, quantity: "10", unit: "pcs" }] });
      assert.equal((await getRecipe(db, finance, fresh.id)).total, 0);
      await db.ingredient.update({ where: { id: free.id }, data: { weightedAverageUnitCostMicros: BigInt("2147483647000000") } });
      const overflow = await getRecipe(db, finance, fresh.id);
      assert.equal(overflow.total, null); assert.equal(overflow.costError, "INVALID_COST"); assert.equal(overflow.items.length, 1);
      await assert.rejects(getRecipeHpp(db, finance, fresh.id), { code: "INVALID_COST" });
      await saveRecipe(db, admin, { ...request(fresh.id, 1), items: [{ ingredientId: free.id, quantity: "1", unit: "pcs" }] });
      assert.equal((await getRecipe(db, finance, fresh.id)).total, 2147483647);
      await assert.rejects(db.recipe.update({ where: { productId: fresh.id }, data: { revision: 0 } }));
    });
    await t.test("current database actor controls every read, write and replay", async () => {
      for (const actor of [cashier, { ...cashier, role: "ADMIN" as const }, { ...admin, id: randomUUID() }]) {
        await assert.rejects(listRecipeOptions(db, actor), { code: "FORBIDDEN" });
        await assert.rejects(getRecipe(db, actor, p.id), { code: "FORBIDDEN" });
        await assert.rejects(saveRecipe(db, actor, request()), { code: "FORBIDDEN" });
      }
      await assert.rejects(saveRecipe(db, finance, request()), { code: "FORBIDDEN" });
      await assert.rejects(saveRecipe(db, { ...finance, role: "ADMIN" }, request()), { code: "FORBIDDEN" });
      await assert.rejects(listIngredients(db, finance), { code: "FORBIDDEN" });
      await db.user.update({ where: { id: stock.id }, data: { role: "FINANCE" } });
      await assert.rejects(saveRecipe(db, stock, savedRequest), { code: "FORBIDDEN" });
      assert.ok(await getRecipe(db, stock, p.id));
      await db.user.update({ where: { id: stock.id }, data: { active: false } });
      await assert.rejects(getRecipe(db, stock, p.id), { code: "FORBIDDEN" });
      await assert.rejects(listRecipeOptions(db, stock), { code: "FORBIDDEN" });
    });
  } finally { await db.$disconnect(); }
});
