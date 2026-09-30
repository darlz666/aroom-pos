import assert from "node:assert/strict";
import { test } from "node:test";
import { expenseCategories, historyFilter, historyPage } from "./presentation";
import type { ReportTransaction } from "../reports/service";

test("category presentation uses integer amounts and rounded percentages", () => {
  const rows = expenseCategories([{ category: "Internet", amount: 100 }, { category: "Gaji", amount: 200 }, { category: "Internet", amount: 100 }]);
  assert.deepEqual(rows.map(row => [row.category, row.amount, row.percentage]), [["Gaji", 200, 50], ["Internet", 200, 50]]);
  assert.equal(rows[0].start, 0); assert.equal(rows[1].end, 100);
  assert.deepEqual(expenseCategories([]), []);
});

test("history is bounded, newest first, searches supported fields and keeps expenses independent of methods", () => {
  const sales = Array.from({ length: 24 }, (_, i) => ({ orderId: String(i), orderNumber: `AROOM-${i}`, paidAt: new Date(Date.UTC(2026, 8, i + 1)).toISOString(), paymentMethod: i % 2 ? "CASH" : "MIDTRANS_QRIS", quantity: 4, totalRevenue: 50000 } as ReportTransaction));
  const expenses = [{ id: "expense", occurredAt: new Date("2026-09-29T00:00:00Z"), category: "Internet", description: "September bill", amount: 100 }];
  const filter = historyFilter({ type: "ALL", method: "ALL", search: "", page: 1 });
  const all = historyPage(sales, expenses, filter);
  assert.equal(all.total, 25); assert.equal(all.rows.length, 10); assert.equal(all.pages, 3); assert.equal(all.rows[0].type, "EXPENSE");
  assert.equal(historyPage(sales, expenses, { ...filter, page: 3 }).rows.length, 5);
  const qris = historyPage(sales, expenses, { ...filter, method: "MIDTRANS_QRIS" });
  assert.equal(qris.total, 13); assert.equal(qris.rows[0].type, "EXPENSE");
  assert.equal(historyPage(sales, expenses, { ...filter, type: "INCOME" }).total, 24);
  assert.equal(historyPage(sales, expenses, { ...filter, type: "EXPENSE", method: "CASH" }).total, 1);
  assert.equal(historyPage(sales, expenses, { ...filter, search: "internet" }).total, 1);
  assert.equal(historyPage(sales, expenses, { ...filter, search: "september" }).total, 1);
  assert.equal(historyPage(sales, expenses, { ...filter, search: "aroom-23" }).total, 1);
  assert.equal(historyPage(sales, expenses, { ...filter, search: "QRIS" }).total, 0);
  assert.throws(() => historyFilter({ ...filter, page: 0 }));
  assert.throws(() => historyFilter({ ...filter, search: "x".repeat(201) }));
});
