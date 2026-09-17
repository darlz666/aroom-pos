import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { createReceiptPrintJob } from "../printing/printer";
import { FakePrinterAdapter } from "../printing/testing/fake-printer";

test("receipt read projection", async (t) => {
  // Allow this server-only service to run in the plain Node test runner.
  const require = createRequire(import.meta.url);
  const serverOnlyPath = require.resolve("server-only");
  const original = require.cache[serverOnlyPath];
  require.cache[serverOnlyPath] = { exports: {} } as NodeModule;
  t.after(() => {
    if (original) require.cache[serverOnlyPath] = original;
    else delete require.cache[serverOnlyPath];
  });
  const { getReceipt } = await import("./receipt");
  const actor = { id: randomUUID(), role: "CASHIER" as const };
  const orderId = randomUUID();
  const shift = { id: randomUUID(), cashierId: actor.id, status: "OPEN" };
  const paidAt = new Date("2026-09-16T02:01:00Z");
  const stored = {
    shift: { ...shift, status: "CLOSED" }, status: "PAID", orderNumber: "AR-000042", orderType: "DINE_IN",
    cashier: { name: "Original cashier", passwordHash: "secret" },
    createdAt: new Date("2026-09-16T02:00:00Z"), paidAt, total: 44000,
    items: [{ productNameSnapshot: "Original coffee", unitPriceSnapshot: 22000, quantity: 2, lineTotal: 44000,
      product: { name: "Renamed coffee", price: 99000 } }],
    payments: [{ status: "SUCCEEDED", method: "CASH", amount: 44000, cashReceived: 50000,
      changeAmount: 6000, edcReference: null, succeededAt: paidAt, requestFingerprint: "secret" }],
  };
  function fixture(order: typeof stored | null = structuredClone(stored), active: typeof shift | null = shift) {
    return { shift: { findFirst: async () => { assert.fail(`Unexpected active shift lookup: ${JSON.stringify(active)}`); } }, order: {
      findUnique: async (args: Prisma.OrderFindUniqueArgs) => {
        assert.deepEqual(args.where, { id: orderId });
        assert.deepEqual((args.select!.payments as Prisma.Order$paymentsArgs).where, { status: "SUCCEEDED" });
        assert.equal(JSON.stringify(args.select).includes('"product"'), false);
        assert.deepEqual(args.select!.shift, { select: { cashierId: true } });
        assert.deepEqual((args.select!.items as Prisma.Order$itemsArgs).orderBy, [{ productId: "asc" }, { id: "asc" }]);
        // Model the successful-payment filter, including earlier unsuccessful attempts.
        return order && { ...order, payments: order.payments.filter((p) => p.status === "SUCCEEDED") };
      },
    } } as unknown as PrismaClient;
  }
  await t.test("paid order returns only the receipt DTO; retries return the same read", async () => {
    const db = fixture();
    const receipt = await getReceipt(db, actor, orderId);
    assert.deepEqual(receipt, {
      orderNumber: "AR-000042", orderType: "DINE_IN", cashier: "Original cashier",
      createdAt: stored.createdAt.toISOString(), paidAt: paidAt.toISOString(), total: 44000,
      items: [{ name: "Original coffee", unitPrice: 22000, quantity: 2, lineTotal: 44000 }],
      payment: { method: "CASH", amount: 44000, cashReceived: 50000, changeAmount: 6000,
        edcReference: null, succeededAt: paidAt.toISOString() },
    });
    assert.deepEqual(await getReceipt(db, actor, orderId), receipt);
  });
  await t.test("unpaid and cancelled orders are rejected", async () => {
    for (const status of ["UNPAID", "CANCELLED"]) {
      await assert.rejects(getReceipt(fixture({ ...stored, status }), actor, orderId), { code: "ORDER_NOT_FOUND" });
    }
  });
  await t.test("only a server-authorized paid receipt reaches the printer", async () => {
    const printer = new FakePrinterAdapter();
    for (const order of [
      { ...stored, status: "UNPAID" }, { ...stored, status: "CANCELLED" },
      { ...stored, payments: [] },
      { ...stored, payments: [{ ...stored.payments[0], status: "PENDING" }] },
      { ...stored, shift: { ...shift, cashierId: randomUUID() } },
    ]) {
      await assert.rejects(async () => createReceiptPrintJob(await getReceipt(fixture(order), actor, orderId), printer).print());
    }
    assert.equal(printer.attempts.length, 0);
    assert.equal((await createReceiptPrintJob(await getReceipt(fixture(), actor, orderId), printer).print()).status, "succeeded");
    assert.equal(printer.attempts.length, 1);
  });
  await t.test("missing order, missing payment and unsuccessful payments are rejected", async () => {
    await assert.rejects(getReceipt(fixture(null), actor, orderId), { code: "ORDER_NOT_FOUND" });
    for (const status of ["PENDING", "FAILED", "EXPIRED", "CANCELLED"]) {
      await assert.rejects(getReceipt(fixture({ ...stored, payments: [{ ...stored.payments[0], status }] }), actor, orderId), { code: "ORDER_NOT_FOUND" });
    }
    await assert.rejects(getReceipt(fixture({ ...stored, payments: [] }), actor, orderId), { code: "ORDER_NOT_FOUND" });
  });
  await t.test("historical shift owner and Admin can read; another cashier cannot", async () => {
    await assert.rejects(getReceipt(fixture({ ...stored, shift: { ...shift, cashierId: randomUUID() } }), actor, orderId), { code: "FORBIDDEN" });
    await assert.rejects(getReceipt(fixture(), { ...actor, id: randomUUID() }, orderId), { code: "FORBIDDEN" });
    const admin = { id: randomUUID(), role: "ADMIN" as const };
    assert.equal((await getReceipt(fixture(), admin, orderId)).cashier, "Original cashier");
    assert.equal((await getReceipt(fixture({ ...stored, shift: { ...shift, cashierId: randomUUID(), status: "CLOSED" } }), admin, orderId)).total, 44000);
    assert.equal((await getReceipt(fixture({ ...stored, cashier: { name: "Assisting Admin", passwordHash: "secret" } }), actor, orderId)).cashier, "Assisting Admin");
    for (const reader of [{ ...actor, id: "" }, { ...actor, role: "INVALID" as "CASHIER" }]) {
      await assert.rejects(getReceipt(fixture(), reader, orderId), { code: "FORBIDDEN" });
    }
  });
  await t.test("receipt reads after closure ignore register state and never mutate historical data", async () => {
    for (const active of [null, shift, { ...shift, id: randomUUID(), cashierId: randomUUID() }]) {
      const order = structuredClone(stored);
      const before = structuredClone(order);
      const db = fixture(order, active);
      const receipt = await getReceipt(db, actor, orderId);
      assert.deepEqual(await getReceipt(db, actor, orderId), receipt);
      assert.deepEqual(order, before);
    }
  });
  await t.test("snapshots survive menu changes and failed payment attempts", async () => {
    const order = structuredClone(stored);
    order.items[0].product = { name: "New menu name", price: 100000 };
    order.payments.unshift({ ...stored.payments[0], status: "FAILED", amount: 1 });
    const receipt = await getReceipt(fixture(order), actor, orderId);
    assert.deepEqual(receipt.items, [{ name: "Original coffee", unitPrice: 22000, quantity: 2, lineTotal: 44000 }]);
    assert.equal(receipt.payment.amount, 44000);
  });
  await t.test("invalid inputs and connection failures are safely rejected", async () => {
    for (const id of ["", "bad", null, { orderId }]) {
      await assert.rejects(getReceipt({} as PrismaClient, actor, id as string), { code: "INVALID_INPUT" });
    }
    const db = { order: { findUnique: async () => { throw new Error("secret connection details"); } } } as unknown as PrismaClient;
    await assert.rejects(getReceipt(db, actor, orderId), { code: "UPDATE_FAILED", message: "UPDATE_FAILED" });
  });
});
