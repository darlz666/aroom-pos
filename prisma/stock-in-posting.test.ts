import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { createIngredient, createStockIn } from "../src/lib/inventory/service";
import { postStockIn } from "../src/lib/inventory/stock-in-posting";
import { stockInFingerprint, stockInInput } from "../src/lib/inventory/stock-in-domain";

test("shared Stock In posting participates in the caller transaction and preserves manual contracts", async t => {
  assert.notEqual(process.env.NODE_ENV, "production");
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/aroom_access_test_[a-f0-9]{32}$/);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  try {
    const actor = await db.user.create({ data: { name: "Posting tester", loginIdentifier: randomUUID(), passwordHash: "unused", role: "STOCK_MANAGEMENT" } });
    const supplier = await db.supplier.create({ data: { name: "Posting supplier" } });
    const milk = await createIngredient(db, actor, { name: randomUUID(), baseUnit: "L" });
    const beans = await createIngredient(db, actor, { name: randomUUID(), baseUnit: "kg" });
    assert.equal(milk.baseUnit, "ml"); assert.equal(beans.baseUnit, "g");
    assert.equal(milk.currentStock.toFixed(), "0"); assert.equal(milk.weightedAverageUnitCostMicros, null);
    const input = (quantity = "6", price = 33333) => ({ idempotencyKey: randomUUID(), supplierId: supplier.id,
      receivedAt: "2026-10-09T09:00:00+07:00", items: [{ ingredientId: milk.id, quantity, unit: "L", purchaseUnitCost: price }] });
    const state = async () => ({ ingredient: await db.ingredient.findUniqueOrThrow({ where: { id: milk.id } }),
      receipts: await db.stockIn.count({ where: { supplierId: supplier.id } }),
      movements: await db.stockMovement.count({ where: { ingredientId: milk.id } }) });
    await t.test("caller failure after posting rolls back receipt, movements, WAC, balance and caller audit", async () => {
      const before = await state(), request = input(), auditId = randomUUID();
      await assert.rejects(db.$transaction(async tx => {
        const receipt = await postStockIn(tx, actor, request);
        assert.equal(receipt.items[0].baseQuantity, "6000");
        await tx.auditLog.create({ data: { id: auditId, actorId: actor.id, action: "TEST_CALLER", entityType: "StockIn", entityId: receipt.id } });
        throw new Error("caller failure after posting");
      }), /caller failure after posting/);
      assert.deepEqual(await state(), before);
      assert.equal(await db.auditLog.count({ where: { id: auditId } }), 0);
      assert.equal(await db.stockIn.count({ where: { idempotencyKey: request.idempotencyKey } }), 0);
      const receipt = await createStockIn(db, actor, request);
      assert.equal(receipt.replayed, false); assert.equal(receipt.items[0].lineTotal, 199998);
      const committed = await state();
      assert.equal(committed.ingredient.currentStock.toFixed(), "6000");
      assert.equal(committed.ingredient.weightedAverageUnitCostMicros, BigInt(33333000));
      assert.deepEqual(await db.$transaction(tx => postStockIn(tx, actor, request)), { ...receipt, replayed: true });
      assert.deepEqual(await state(), committed);
    });
    await t.test("helper and public API share duplicate protection; backdated delivery uses locked current WAC", async () => {
      const request = { ...input("4", 35000), receivedAt: "2026-10-01T09:00:00+07:00" };
      const [a, b] = await Promise.all([createStockIn(db, actor, request), db.$transaction(tx => postStockIn(tx, actor, request))]);
      assert.equal(a.id, b.id); assert.notEqual(a.replayed, b.replayed);
      const after = await state();
      assert.equal(after.ingredient.currentStock.toFixed(), "10000");
      assert.equal(after.ingredient.weightedAverageUnitCostMicros, BigInt(33999800));
      assert.equal(after.receipts, 2); assert.equal(after.movements, 2);
      await assert.rejects(db.$transaction(tx => postStockIn(tx, actor, { ...request, notes: "different intent" })), { code: "IDEMPOTENCY_CONFLICT" });
      await db.supplier.update({ where: { id: supplier.id }, data: { active: false } });
      assert.deepEqual(await createStockIn(db, actor, request), { ...a, replayed: true });
      assert.deepEqual(await state(), after);
      await db.supplier.update({ where: { id: supplier.id }, data: { active: true } });
    });
    await t.test("historical integer-base-cost fingerprints replay without changing persisted evidence", async () => {
      const request = { ...input(), items: [{ ingredientId: beans.id, quantity: "100", unit: "g", unitCost: 25 }] };
      const receipt = await db.stockIn.create({ data: {
        referenceNumber: `SI-${randomUUID()}`, idempotencyKey: request.idempotencyKey,
        requestFingerprint: stockInFingerprint(actor.id, stockInInput(request)), supplierId: supplier.id,
        supplierNameSnapshot: supplier.name, receivedAt: new Date(request.receivedAt), actorId: actor.id,
        items: { create: { ingredientId: beans.id, ingredientNameSnapshot: beans.name,
          inputQuantity: 100, inputUnit: "g", baseQuantity: 100, baseUnit: "g", unitCost: 25, lineTotal: 2500 } },
      }, include: { items: true } });
      const before = await db.ingredient.findUniqueOrThrow({ where: { id: beans.id } });
      for (const result of [await createStockIn(db, actor, request), await db.$transaction(tx => postStockIn(tx, actor, request))]) {
        assert.equal(result.id, receipt.id); assert.equal(result.replayed, true);
        assert.equal(result.items[0].unitCost, 25); assert.equal(result.items[0].receivedUnitCostMicros, null);
      }
      assert.deepEqual(await db.stockIn.findUniqueOrThrow({ where: { id: receipt.id }, include: { items: true } }), receipt);
      assert.deepEqual(await db.ingredient.findUniqueOrThrow({ where: { id: beans.id } }), before);
      assert.equal(await db.stockMovement.count({ where: { ingredientId: beans.id } }), 0);
    });
    await t.test("helper independently rejects forged and revoked actors and rolls back caller work", async () => {
      const cashier = await db.user.create({ data: { name: "Cashier", loginIdentifier: randomUUID(), passwordHash: "unused", role: "CASHIER" } });
      const auditId = randomUUID(), before = await state();
      await assert.rejects(db.$transaction(async tx => {
        await tx.auditLog.create({ data: { id: auditId, actorId: actor.id, action: "TEST_CALLER", entityType: "StockIn", entityId: milk.id } });
        return postStockIn(tx, { ...cashier, role: "ADMIN" }, input());
      }), { code: "FORBIDDEN" });
      assert.equal(await db.auditLog.count({ where: { id: auditId } }), 0);
      await db.user.update({ where: { id: actor.id }, data: { active: false } });
      await assert.rejects(db.$transaction(tx => postStockIn(tx, actor, input())), { code: "FORBIDDEN" });
      assert.deepEqual(await state(), before);
    });
  } finally { await db.$disconnect(); }
});
