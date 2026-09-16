import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { OrderStatus, PaymentMethod, PaymentStatus, PrismaClient } from "../../generated/prisma/client";

const shiftId = "00000000-0000-4000-8000-000000000001";
const openedAt = new Date("2026-09-15T16:00:00Z");
type StoredOrder = { shiftId: string; status: OrderStatus; payments: {
  method: PaymentMethod; status: PaymentStatus; amount: number; cashReceived?: number;
}[] };
const paid = (method: PaymentMethod, amount: number): StoredOrder => ({
  shiftId, status: "PAID", payments: [{ method, status: "SUCCEEDED", amount, cashReceived: 100000 }],
});

test("shift settlement", async (t) => {
  const require = createRequire(import.meta.url);
  const serverOnlyPath = require.resolve("server-only");
  const original = require.cache[serverOnlyPath];
  require.cache[serverOnlyPath] = { exports: {} } as NodeModule;
  t.after(() => {
    if (original) require.cache[serverOnlyPath] = original;
    else delete require.cache[serverOnlyPath];
  });
  const { getShiftSettlement } = await import("./settlement");

  function fixture(orders: StoredOrder[] = [], closedAt: Date | null = null) {
    const tx = {
      shift: { findUniqueOrThrow: async (args: unknown) => {
        assert.deepEqual(args, { where: { id: shiftId },
          select: { id: true, openedAt: true, closedAt: true, openingCash: true } });
        return { id: shiftId, openedAt, closedAt, openingCash: 100000 };
      } },
      order: { groupBy: async (args: unknown) => {
        assert.deepEqual(args, { by: ["status"], where: { shiftId }, _count: { _all: true } });
        return (["PAID", "UNPAID", "CANCELLED"] as const).map((status) => ({
          status, _count: { _all: orders.filter((o) => o.shiftId === shiftId && o.status === status).length },
        }));
      } },
      payment: { groupBy: async (args: unknown) => {
        assert.deepEqual(args, { by: ["method"],
          where: { status: "SUCCEEDED", order: { shiftId, status: "PAID" } }, _sum: { amount: true } });
        const payments = orders.filter((o) => o.shiftId === shiftId && o.status === "PAID")
          .flatMap((o) => o.payments).filter((p) => p.status === "SUCCEEDED");
        return (["CASH", "BCA_EDC", "MIDTRANS_QRIS"] as const).map((method) => ({
          method, _sum: { amount: payments.filter((p) => p.method === method).reduce((sum, p) => sum + p.amount, 0) },
        }));
      } },
    };
    return { $transaction: async (work: (client: typeof tx) => Promise<unknown>, options: unknown) => {
      assert.deepEqual(options, { isolationLevel: "RepeatableRead" });
      return work(tx);
    } } as unknown as PrismaClient;
  }

  await t.test("empty shift preserves opening cash", async () => {
    assert.deepEqual(await getShiftSettlement(fixture(), shiftId), {
      shiftId, openedAt, closedAt: null, totalOrders: 0, paidOrders: 0, cancelledOrders: 0,
      grossSales: 0, cashSales: 0, edcSales: 0, expectedCash: 100000,
    });
  });
  await t.test("cash aggregates payment amounts, not tendered cash; retries are stable", async () => {
    const db = fixture([paid("CASH", 22000), paid("CASH", 18000)]);
    const result = await getShiftSettlement(db, shiftId);
    assert.equal(result.cashSales, 40000);
    assert.equal(result.grossSales, 40000);
    assert.equal(result.expectedCash, 140000);
    assert.equal(result.paidOrders, 2);
    assert.deepEqual(await getShiftSettlement(db, shiftId), result);
  });
  await t.test("EDC aggregates without increasing drawer cash", async () => {
    const result = await getShiftSettlement(fixture([paid("BCA_EDC", 22000), paid("BCA_EDC", 33000)]), shiftId);
    assert.equal(result.edcSales, 55000);
    assert.equal(result.grossSales, 55000);
    assert.equal(result.cashSales, 0);
    assert.equal(result.expectedCash, 100000);
  });
  for (const status of ["CANCELLED", "UNPAID"] as const) {
    await t.test(`${status} orders are counted but excluded from sales`, async () => {
      const result = await getShiftSettlement(fixture([{ ...paid("CASH", 22000), status }]), shiftId);
      assert.equal(result.totalOrders, 1);
      assert.equal(result.paidOrders, 0);
      assert.equal(result.cancelledOrders, status === "CANCELLED" ? 1 : 0);
      assert.equal(result.grossSales, 0);
      assert.equal(result.cashSales, 0);
      assert.equal(result.expectedCash, 100000);
    });
  }
  await t.test("unsuccessful attempts and other shifts never contribute", async () => {
    const order = paid("CASH", 22000);
    for (const status of ["PENDING", "FAILED", "EXPIRED", "CANCELLED"] as const) {
      order.payments.push({ method: "CASH", amount: 99000, status });
    }
    const result = await getShiftSettlement(fixture([order, { ...paid("BCA_EDC", 88000), shiftId: "another-shift" }]), shiftId);
    assert.equal(result.totalOrders, 1);
    assert.equal(result.paidOrders, 1);
    assert.equal(result.grossSales, 22000);
    assert.equal(result.edcSales, 0);
  });
  await t.test("closed shifts include all methods across midnight", async () => {
    const closedAt = new Date("2026-09-15T19:00:00Z");
    const result = await getShiftSettlement(fixture([paid("CASH", 22000), paid("BCA_EDC", 18000), paid("MIDTRANS_QRIS", 30000)], closedAt), shiftId);
    assert.equal(result.closedAt, closedAt);
    assert.equal(result.grossSales, 70000);
    assert.equal(result.expectedCash, 122000);
  });
  await t.test("invalid IDs and database failures reject instead of returning zero sales", async () => {
    await assert.rejects(getShiftSettlement(fixture(), "invalid"), { code: "INVALID_INPUT" });
    const failure = new Error("Database unavailable or shift missing");
    const db = { $transaction: async () => { throw failure; } } as unknown as PrismaClient;
    await assert.rejects(getShiftSettlement(db, shiftId), (error: unknown) => error === failure);
  });
});
