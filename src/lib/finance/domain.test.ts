import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { expenseInput, periodRange, sumMoney } from "./domain";
import { inventoryValue, summarize } from "./service";
import type { ReportTransaction } from "../reports/service";

test("Jakarta half-open day/month/year/lifetime ranges and leap calendar validation", () => {
  for (const [input, start, end] of [
    [{ type: "DAY", value: "2024-02-29" }, "2024-02-28T17:00:00.000Z", "2024-02-29T17:00:00.000Z"],
    [{ type: "MONTH", value: "2024-02" }, "2024-01-31T17:00:00.000Z", "2024-02-29T17:00:00.000Z"],
    [{ type: "MONTH", value: "2026-12" }, "2026-11-30T17:00:00.000Z", "2026-12-31T17:00:00.000Z"],
    [{ type: "YEAR", value: "2026" }, "2025-12-31T17:00:00.000Z", "2026-12-31T17:00:00.000Z"],
  ] as const) {
    const range = periodRange(input); assert.equal(range.start!.toISOString(), start); assert.equal(range.end.toISOString(), end);
  }
  const now = new Date("2026-09-29T09:00:00Z"); assert.equal(periodRange({ type: "LIFETIME" }, now).end, now);
  for (const input of [null, {}, { type: "DAY", value: "2023-02-29" }, { type: "MONTH", value: "2026-13" }, { type: "MONTH", value: "2026-2" }, { type: "YEAR", value: "2026.5" }, { type: "YEAR", value: "0000" }, { type: "LIFETIME", value: "2026" }, { type: "DAY", value: "2026-01-01", actorId: "forged" }]) assert.throws(() => periodRange(input));
});
test("expenses strictly validate date, actor injection and unformatted positive integer IDR", () => {
  const input = { operation: "CREATE", id: randomUUID(), key: randomUUID(), revision: 0, date: "2026-09-01", amount: 25000, category: "Gaji", description: " Wages ", note: "" };
  assert.equal(expenseInput(input).data!.occurredAt.toISOString(), "2026-08-31T17:00:00.000Z");
  for (const amount of [0, -1, 0.5, "25.000", "25000", "1e3", 2147483648, NaN]) assert.throws(() => expenseInput({ ...input, amount }));
  assert.throws(() => expenseInput({ ...input, actorId: randomUUID() }));
  assert.throws(() => expenseInput({ ...input, role: "ADMIN" }));
  assert.throws(() => expenseInput({ ...input, date: "2026-02-30" }));
});
test("server summary preserves gross payment totals, expenses and unknown HPP", () => {
  const sale = { totalRevenue: 100000, hpp: 40000, grossProfit: 60000, channelFee: 10000, adsCost: 0, netRevenue: 50000, paymentMethod: "CASH" } as ReportTransaction;
  const report = summarize([sale], [{ amount: 20000 }]);
  assert.equal(report.paidSales, 100000); assert.equal(report.cashTotal, 100000); assert.equal(report.netIncome, 30000); assert.equal(report.salesDeductions, 10000);
  const unknown = summarize([sale, { ...sale, hpp: null, grossProfit: null, netRevenue: null }], [{ amount: 1 }]);
  assert.equal(unknown.hpp, null); assert.equal(unknown.grossProfit, null); assert.equal(unknown.netIncome, null);
  assert.equal(summarize([], []).netIncome, 0); assert.equal(summarize([], [{ amount: 20000 }]).netIncome, -20000);
  assert.throws(() => sumMoney([Number.MAX_SAFE_INTEGER, 1]));
  assert.throws(() => sumMoney([0.5]));
});
test("current valuation uses WAC, rounds exact contributions and never invents missing costs", () => {
  const row = (stock: string, cost: bigint | null) => ({ currentStock: stock, weightedAverageUnitCostMicros: cost });
  assert.deepEqual(inventoryValue([row("17000", BigInt(33529412))]), { amount: 570000, missing: 0 });
  assert.deepEqual(inventoryValue([row("0", null)]), { amount: 0, missing: 0 });
  assert.deepEqual(inventoryValue([row("1", null), row("1", BigInt(1000000))]), { amount: null, missing: 1 });
  assert.equal(inventoryValue([row("0.5", BigInt(1000000)), row("0.5", BigInt(1000000))]).amount, 2);
  assert.throws(() => inventoryValue([row("999999999999999.999", BigInt(2147483647000000))]));
});
