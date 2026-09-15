import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../src/generated/prisma/client";
import { createOrder, cancelOrder, editOrder } from "../src/lib/orders/service";
import { closeShift } from "../src/lib/shifts/service";
import { recordManualPayment } from "../src/lib/payments/service";

test("payment PostgreSQL authority, atomicity, retries, constraints and existing workflows", async t => {
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.ok(process.env.DATABASE_URL);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL).hostname));
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const cashier = { id: randomUUID(), role: "CASHIER" as const };
  const admin = { id: randomUUID(), role: "ADMIN" as const };
  const other = { id: randomUUID(), role: "CASHIER" as const };
  const ids = [cashier.id, admin.id, other.id];
  const categoryId = randomUUID();
  const snapshot = async () => ({ orders: await db.order.findMany({ orderBy: { id: "asc" } }), payments: await db.payment.findMany({ orderBy: { id: "asc" } }), shifts: await db.shift.findMany({ orderBy: { id: "asc" } }) });
  const before = await snapshot();
  try {
    assert.equal(before.shifts.filter(s => s.status === "OPEN").length, 0, "Requires idle development register");
    for (const actor of [cashier, admin, other]) await db.user.create({ data: { ...actor, name: "Payment fixture", loginIdentifier: randomUUID(), passwordHash: "unused" } });
    await db.category.create({ data: { id: categoryId, name: "Payment fixture" } });
    const product = await db.product.create({ data: { categoryId, name: "Coffee", price: 22000 } });
    const shift = await db.shift.create({ data: { cashierId: cashier.id, openingCash: 0 } });
    const create = () => createOrder(db, cashier, { createIdempotencyKey: randomUUID(), orderType: "DINE_IN", items: [{ productId: product.id, quantity: 1 }] });
    const request = (order: { id: string; revision: number }) => ({ orderId: order.id, expectedRevision: order.revision, attemptIdentifier: randomUUID(), method: "CASH", cashReceived: 30000 });
    let saved!: ReturnType<typeof request>;
    await t.test("database rejects invalid payment rows and preserves attempt identity", async () => {
      const order = await create();
      const base = { orderId: order.id, method: "CASH" as const, status: "PENDING" as const, amount: order.total, attemptIdentifier: randomUUID() };
      for (const invalid of [
        { amount: -1 }, { status: "SUCCEEDED" as const }, { succeededAt: new Date() },
        { status: "SUCCEEDED" as const, succeededAt: new Date() },
        { cashReceived: 21000, changeAmount: 0 }, { cashReceived: 30000, changeAmount: 1 },
        { cashReceived: 30000 }, { changeAmount: 0 }, { edcReference: "wrong method" },
        { midtransReference: "wrong method" }, { method: "BCA_EDC" as const, cashReceived: 22000, changeAmount: 0 },
      ]) await assert.rejects(db.payment.create({ data: { ...base, ...invalid } }));
      const pending = await db.payment.create({ data: base });
      await assert.rejects(db.payment.create({ data: { ...base, attemptIdentifier: randomUUID() } }));
      for (const data of [{ amount: 1 }, { method: "BCA_EDC" as const }, { attemptIdentifier: randomUUID() }, { requestFingerprint: "changed" }]) {
        await assert.rejects(db.payment.update({ where: { id: pending.id }, data }));
      }
      await db.payment.update({ where: { id: pending.id }, data: { status: "EXPIRED" } });
      await assert.rejects(db.payment.create({ data: { ...base, status: "FAILED" } })); // Globally unique attempt key.
      await cancelOrder(db, cashier, { orderId: order.id, expectedRevision: 1 });
    });
    await t.test("simultaneous same-key submission records once and recovers; new keys cannot repay", async () => {
      const order = await create(); saved = request(order);
      const results = await Promise.all([recordManualPayment(db, cashier, saved), recordManualPayment(db, cashier, saved)]);
      assert.equal(results[0].id, results[1].id);
      assert.equal(results.filter(r => r.replayed).length, 1);
      assert.equal(results[0].amount, 22000); assert.equal(results[0].changeAmount, 8000);
      const paid = await db.order.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(paid.status, "PAID"); assert.equal(paid.revision, 2);
      assert.equal(paid.paidAt!.toISOString(), results[0].succeededAt);
      assert.equal(await db.auditLog.count({ where: { entityId: results[0].id, actorId: cashier.id } }), 1);
      await assert.rejects(recordManualPayment(db, cashier, request(order)), { code: "ORDER_NOT_PAYABLE" });
      await assert.rejects(recordManualPayment(db, cashier, { ...saved, cashReceived: 40000 }), { code: "IDEMPOTENCY_CONFLICT" });
      await assert.rejects(recordManualPayment(db, other, saved), { code: "IDEMPOTENCY_CONFLICT" });
      await assert.rejects(cancelOrder(db, cashier, { orderId: order.id, expectedRevision: 2 }), { code: "ORDER_NOT_EDITABLE" });
      await assert.rejects(editOrder(db, cashier, { orderId: order.id, expectedRevision: 2, operation: { type: "SET_QUANTITY", orderItemId: order.items[0].id, quantity: 2 } }), { code: "ORDER_NOT_EDITABLE" });
      await assert.rejects(db.payment.update({ where: { id: results[0].id }, data: { status: "FAILED", succeededAt: null } }));
      await assert.rejects(db.payment.create({ data: { orderId: order.id, method: "BCA_EDC", status: "SUCCEEDED", amount: 22000, succeededAt: new Date(), attemptIdentifier: randomUUID() } }));
    });
    await t.test("permissions, stale requests, totals, menu drift and pending attempts reject without paying", async () => {
      const order = await create(); const input = request(order);
      for (const [actor, raw, code] of [[other, input, "FORBIDDEN"], [cashier, { ...input, total: 1 }, "INVALID_INPUT"], [cashier, { ...input, expectedRevision: 2 }, "REVISION_CONFLICT"], [cashier, { ...input, cashReceived: 1 }, "INSUFFICIENT_CASH"]] as const) await assert.rejects(recordManualPayment(db, actor, raw), { code });
      await db.product.update({ where: { id: product.id }, data: { price: 23000 } });
      await assert.rejects(recordManualPayment(db, cashier, input), { code: "PRICE_CHANGED" });
      await db.product.update({ where: { id: product.id }, data: { price: 22000, available: false } });
      await assert.rejects(recordManualPayment(db, cashier, input), { code: "PRODUCT_UNAVAILABLE" });
      await db.product.update({ where: { id: product.id }, data: { available: true } });
      const pending = await db.payment.create({ data: { orderId: order.id, method: "MIDTRANS_QRIS", amount: order.total, attemptIdentifier: randomUUID() } });
      await assert.rejects(recordManualPayment(db, cashier, input), { code: "PAYMENT_BLOCKED" });
      await assert.rejects(closeShift(db, cashier, { shiftId: shift.id, countedCash: 22000 }), { code: "UNRESOLVED_TRANSACTIONS" });
      await db.payment.update({ where: { id: pending.id }, data: { status: "FAILED" } });
      const { cashReceived: _cash, ...identity } = input; void _cash;
      assert.equal((await recordManualPayment(db, admin, { ...identity, method: "BCA_EDC", edcReference: "APPROVED" })).amount, 22000);
    });
    await t.test("transaction failure rolls back payment, order and audit; connectivity has a controlled error", async () => {
      const order = await create(); const input = request(order);
      const broken = new Proxy(db, { get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key);
        return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => db.$transaction(tx => fn(new Proxy(tx, { get(client, field) {
          if (field === "auditLog") return { create: async () => { throw new Error("private details"); } };
          return Reflect.get(client, field);
        } })));
      } });
      await assert.rejects(recordManualPayment(broken, cashier, input), { code: "PAYMENT_FAILED", message: "PAYMENT_FAILED" });
      assert.equal(await db.payment.count({ where: { orderId: order.id } }), 0);
      assert.equal((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status, "UNPAID");
      const offline = { payment: { findUnique: async () => { throw new Error("private connection"); } } } as unknown as PrismaClient;
      await assert.rejects(recordManualPayment(offline, cashier, input), { code: "PAYMENT_FAILED" });
      await cancelOrder(db, cashier, { orderId: order.id, expectedRevision: 1 });
      await assert.rejects(recordManualPayment(db, cashier, input), { code: "ORDER_NOT_PAYABLE" });
    });
    await t.test("different concurrent keys and cancellation race never produce duplicate success", async () => {
      const order = await create();
      const outcomes = await Promise.allSettled([recordManualPayment(db, cashier, request(order)), recordManualPayment(db, cashier, request(order)), cancelOrder(db, cashier, { orderId: order.id, expectedRevision: 1 })]);
      assert.equal(outcomes.filter(o => o.status === "fulfilled").length, 1);
      const row = await db.order.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(await db.payment.count({ where: { orderId: order.id, status: "SUCCEEDED" } }), row.status === "PAID" ? 1 : 0);
    });
    await t.test("closing reconciles payment amounts and same-key recovery works after closure", async () => {
      const cash = await db.payment.aggregate({ where: { order: { shiftId: shift.id }, status: "SUCCEEDED", method: "CASH" }, _sum: { amount: true } });
      const closed = await closeShift(db, cashier, { shiftId: shift.id, countedCash: cash._sum.amount! });
      assert.equal(closed.expectedCash, cash._sum.amount);
      assert.equal((await recordManualPayment(db, cashier, saved)).replayed, true);
      await assert.rejects(recordManualPayment(db, cashier, { ...saved, attemptIdentifier: randomUUID() }), { code: "NO_ACTIVE_SHIFT" });
    });
  } finally {
    await db.$transaction(async tx => {
      await tx.auditLog.deleteMany({ where: { actorId: { in: ids } } });
      await tx.payment.deleteMany({ where: { order: { cashierId: { in: ids } } } });
      await tx.orderItem.deleteMany({ where: { order: { cashierId: { in: ids } } } });
      await tx.order.deleteMany({ where: { cashierId: { in: ids } } });
      await tx.shift.deleteMany({ where: { cashierId: { in: ids } } });
      await tx.product.deleteMany({ where: { categoryId } });
      await tx.category.deleteMany({ where: { id: categoryId } });
      await tx.user.deleteMany({ where: { id: { in: ids } } });
    });
    try { assert.deepEqual(await snapshot(), before); } finally { await db.$disconnect(); }
  }
});
