import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import type { PaymentMethod, PaymentStatus, OrderStatus, PrismaClient, ShiftStatus } from "../../generated/prisma/client";
import { businessDateRange, jakartaBusinessDate } from "./domain";

const admin = { id: "admin", role: "ADMIN" as const };
const start = new Date("2026-09-16T17:00:00.000Z");
const end = new Date("2026-09-17T17:00:00.000Z");
const payment = (method: PaymentMethod = "CASH", amount = 22000, time = start) => ({
  id: crypto.randomUUID(), orderId: crypto.randomUUID(), method, amount, succeededAt: time as Date | null,
  status: "SUCCEEDED" as PaymentStatus, cashReceived: 100000,
  order: { shiftId: "shift", status: "PAID" as OrderStatus, createdAt: new Date("2026-09-01T00:00:00Z") },
});
const shift = (status: ShiftStatus = "CLOSED") => ({
  id: "shift", status, openedAt: new Date("2026-09-16T16:00:00Z"),
  closedAt: status === "CLOSED" ? new Date("2026-09-17T18:00:00Z") : null,
  openingCash: 100000, expectedCash: status === "CLOSED" ? 144000 : null,
  countedCash: status === "CLOSED" ? 143000 : null, variance: status === "CLOSED" ? -1000 : null,
  cashier: { name: "Cashier" },
});
function fixture(payments = [payment()], shifts = [shift()]) {
  const before = structuredClone({ payments, shifts });
  let reads = 0;
  let aggregates = 0;
  // Deliberately no write methods. A mutation or undeclared read fails the test.
  const tx = {
    payment: {
      groupBy: async (query: { where: { succeededAt: { gte: Date; lt: Date } } }) => {
        reads++;
        const { gte, lt } = query.where.succeededAt;
        assert.deepEqual(query, { by: ["method"], where: {
          status: "SUCCEEDED", succeededAt: { gte, lt }, order: { status: "PAID" },
        }, _sum: { amount: true }, _count: { _all: true } });
        return (["CASH", "BCA_EDC", "MIDTRANS_QRIS"] as const).map(method => {
          const rows = payments.filter(p => p.method === method && p.status === "SUCCEEDED" &&
            p.order.status === "PAID" && p.succeededAt && p.succeededAt >= gte && p.succeededAt < lt);
          return { method, _sum: { amount: rows.reduce((sum, p) => sum + p.amount, 0) }, _count: { _all: rows.length } };
        });
      },
      aggregate: async (query: { where: { order: { shiftId: string } } }) => {
        aggregates++;
        const shiftId = query.where.order.shiftId;
        assert.deepEqual(query, { where: { status: "SUCCEEDED", order: { shiftId, status: "PAID" }, method: "CASH" }, _sum: { amount: true } });
        return { _sum: { amount: payments.filter(p => p.order.shiftId === shiftId && p.order.status === "PAID" &&
          p.status === "SUCCEEDED" && p.method === "CASH").reduce((sum, p) => sum + p.amount, 0) } };
      },
    },
    shift: { findMany: async (query: { where: { openedAt: { lt: Date }; OR: [unknown, { closedAt: { gte: Date } }] }; select: unknown; orderBy: unknown }) => {
      reads++;
      assert.deepEqual(query.where, { openedAt: { lt: end }, OR: [{ closedAt: null }, { closedAt: { gte: start } }] });
      assert.doesNotMatch(JSON.stringify(query.select), /password|loginIdentifier|payments|orders/);
      return shifts.filter(s => s.openedAt < query.where.openedAt.lt &&
        (!s.closedAt || s.closedAt >= query.where.OR[1].closedAt.gte));
    } },
  };
  const db = { $transaction: async (work: (client: typeof tx) => unknown, options: unknown) => {
    reads++;
    assert.deepEqual(options, { isolationLevel: "RepeatableRead" });
    return work(tx);
  } } as unknown as PrismaClient;
  return { db, get reads() { return reads; }, get aggregates() { return aggregates; },
    unchanged() { assert.deepEqual({ payments, shifts }, before); } };
}

test("Jakarta date validation and UTC boundaries", () => {
  assert.deepEqual(businessDateRange("2026-09-17"), { businessDate: "2026-09-17", start, end });
  assert.equal(jakartaBusinessDate(new Date("2026-09-16T16:59:59.999Z")), "2026-09-16");
  assert.equal(jakartaBusinessDate(start), "2026-09-17");
  assert.equal(businessDateRange("2024-02-29").end.toISOString(), "2024-02-29T17:00:00.000Z");
  assert.equal(businessDateRange("2026-12-31").end.toISOString(), "2026-12-31T17:00:00.000Z");
  for (const invalid of [undefined, null, 20260917, {}, { date: "2026-09-17", total: 1 }, "", "2026-9-17", "2026-02-29", "2026-04-31", "2026-13-01", "0000-01-01", " 2026-09-17", "2026-09-17T00:00:00Z"]) {
    assert.throws(() => businessDateRange(invalid), { code: "INVALID_DATE" });
  }
});

test("daily reporting service", async t => {
  const require = createRequire(import.meta.url);
  const path = require.resolve("server-only");
  const previous = require.cache[path];
  require.cache[path] = { exports: {} } as NodeModule;
  t.after(() => { if (previous) require.cache[path] = previous; else delete require.cache[path]; });
  const { getDailyReport } = await import("./service");
  const read = (f: ReturnType<typeof fixture>) => getDailyReport(f.db, admin, "2026-09-17");

  await t.test("normal report includes Cash, EDC and QRIS once and remains read-only on retry", async () => {
    const f = fixture([payment(), payment("BCA_EDC", 33000), payment("MIDTRANS_QRIS", 44000)]);
    const report = await read(f);
    assert.deepEqual({ ...report, shifts: [] }, { businessDate: "2026-09-17", paidSales: 99000,
      paidOrderCount: 3, cashTotal: 22000, edcTotal: 33000, qrisTotal: 44000, shifts: [] });
    assert.deepEqual(await read(f), report);
    f.unchanged();
  });
  await t.test("date is half-open at Jakarta midnight, independent of order creation and payment attempt creation", async () => {
    const rows = [payment("CASH", 1, new Date(start.getTime() - 1)), payment("CASH", 2, start),
      payment("CASH", 4, new Date(end.getTime() - 1)), payment("CASH", 8, end)];
    rows[3].order.createdAt = start; // Created today, paid tomorrow: excluded.
    const result = await read(fixture(rows));
    assert.equal(result.paidSales, 6);
    assert.equal(result.paidOrderCount, 2);
  });
  await t.test("multiple failed/pending/expired/cancelled attempts on the same paid order never inflate sales", async () => {
    const success = payment();
    const rows = [success, ...(["FAILED", "PENDING", "EXPIRED", "CANCELLED"] as const).map(status =>
      ({ ...payment("BCA_EDC", 99000), orderId: success.orderId, status }))];
    const result = await read(fixture(rows));
    assert.equal(result.paidSales, 22000);
    assert.equal(result.paidOrderCount, 1);
    assert.equal(result.edcTotal, 0);
  });
  await t.test("unpaid/cancelled orders and absent success time contribute nothing", async () => {
    const rows = [payment(), payment(), payment()];
    rows[0].order.status = "UNPAID";
    rows[1].order.status = "CANCELLED";
    rows[2].succeededAt = null;
    const result = await read(fixture(rows));
    assert.equal(result.paidSales, 0);
    assert.equal(result.paidOrderCount, 0);
  });
  await t.test("midnight-spanning closed shift preserves all persisted cash values without aggregation", async () => {
    const saved = shift();
    // Deliberately different from the available payment rows: no historical recalculation.
    saved.expectedCash = 180000; saved.countedCash = 181000; saved.variance = 1000;
    const f = fixture([payment()], [saved]);
    assert.deepEqual((await read(f)).shifts[0], { id: saved.id, status: "CLOSED", cashierName: "Cashier",
      openedAt: saved.openedAt.toISOString(), closedAt: saved.closedAt!.toISOString(),
      openingCash: 100000, expectedCash: 180000, countedCash: 181000, variance: 1000 });
    assert.equal(f.aggregates, 0);
    f.unchanged();
  });
  await t.test("open shift expected cash includes the whole shift, not just daily sales or cash tendered", async () => {
    const f = fixture([payment("CASH", 10000, new Date(start.getTime() - 1)), payment(),
      payment("BCA_EDC", 33000), payment("MIDTRANS_QRIS", 44000)], [shift("OPEN")]);
    const report = await read(f);
    assert.equal(report.cashTotal, 22000);
    assert.equal(report.shifts[0].expectedCash, 132000);
    assert.equal(report.shifts[0].countedCash, null);
    assert.equal(report.shifts[0].variance, null);
    f.unchanged();
  });
  await t.test("shift selection includes no-sales shifts and midnight closure but excludes other dates", async () => {
    const atStart = { ...shift(), id: "at-start", closedAt: start };
    const old = { ...shift(), id: "old", closedAt: new Date(start.getTime() - 1) };
    const future = { ...shift(), id: "future", openedAt: end };
    const report = await read(fixture([], [atStart, old, future]));
    assert.deepEqual(report.shifts.map(s => s.id), ["at-start"]);
    assert.equal(report.paidSales, 0);
  });
  await t.test("empty date produces explicit zero totals only after successful reads", async () => {
    assert.deepEqual(await read(fixture([], [])), { businessDate: "2026-09-17", paidSales: 0,
      paidOrderCount: 0, cashTotal: 0, edcTotal: 0, qrisTotal: 0, shifts: [] });
  });
  await t.test("non-admin and malformed date reject before any report database access", async () => {
    const f = fixture();
    await assert.rejects(getDailyReport(f.db, { id: "cashier", role: "CASHIER" }, "2026-09-17"), { code: "FORBIDDEN" });
    await assert.rejects(getDailyReport(f.db, { id: "", role: "ADMIN" }, "2026-09-17"), { code: "FORBIDDEN" });
    await assert.rejects(getDailyReport(f.db, admin, "2026-02-30"), { code: "INVALID_DATE" });
    await assert.rejects(getDailyReport(f.db, admin, { date: "2026-09-17", paidSales: 1 }), { code: "INVALID_DATE" });
    assert.equal(f.reads, 0);
  });
  await t.test("database failures, incomplete closed values and unsafe sums fail with a controlled error", async () => {
    const broken = { $transaction: async () => { throw new Error("database secret"); } } as unknown as PrismaClient;
    await assert.rejects(getDailyReport(broken, admin, "2026-09-17"), { code: "UNAVAILABLE", message: "UNAVAILABLE" });
    await assert.rejects(read(fixture([], [{ ...shift(), countedCash: null }])), { code: "UNAVAILABLE" });
    await assert.rejects(read(fixture([payment("CASH", Number.MAX_SAFE_INTEGER), payment()])), { code: "UNAVAILABLE" });
  });
});
