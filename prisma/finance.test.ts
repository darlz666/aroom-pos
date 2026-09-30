import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../src/generated/prisma/client";
import { getFinanceReport, listExpenses, saveExpense } from "../src/lib/finance/service";
import { adjustTransaction, voidTransactions } from "../src/lib/reports/adjustment-service";

test("Finance expense authorization, concurrency, rollback and period reporting in PostgreSQL", async t => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.match(url.pathname, /^\/aroom_report_test_/);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  const actors = await Promise.all((["ADMIN", "FINANCE", "CASHIER", "STOCK_MANAGEMENT"] as const).map(role => db.user.create({ data: { name: role, role, loginIdentifier: randomUUID(), passwordHash: "unused" } })));
  const [admin, finance, cashier, stock] = actors;
  const request = () => ({ operation: "CREATE", id: randomUUID(), key: randomUUID(), revision: 0, date: "2042-09-01", amount: 10000, category: "Internet", description: "Connection" });
  const month = { type: "MONTH", value: "2042-09" };
  try {
    await t.test("rejects unauthenticated, wrong-role, forged and inactive actors", async () => {
      for (const actor of [{ id: "", role: "FINANCE" as const }, cashier, stock, { ...cashier, role: "FINANCE" as const }]) {
        await assert.rejects(getFinanceReport(db, actor, month));
        await assert.rejects(listExpenses(db, actor, month));
        await assert.rejects(saveExpense(db, actor, request()));
      }
      await db.user.update({ where: { id: finance.id }, data: { active: false } });
      await assert.rejects(getFinanceReport(db, finance, month)); await assert.rejects(saveExpense(db, finance, request()));
      await db.user.update({ where: { id: finance.id }, data: { active: true } });
    });
    const create = request();
    await t.test("concurrent duplicate create, edit, stale revision, replay after edit and soft delete", async () => {
      await Promise.all([saveExpense(db, finance, create), saveExpense(db, finance, create)]);
      assert.equal(await db.financeExpense.count({ where: { id: create.id } }), 1);
      assert.equal(await db.auditLog.count({ where: { entityId: create.id } }), 1);
      await assert.rejects(saveExpense(db, finance, { ...create, amount: 20000 }));
      const edit = { ...create, operation: "EDIT", key: randomUUID(), revision: 1, amount: 15000 };
      await saveExpense(db, finance, edit);
      assert.equal((await getFinanceReport(db, finance, month)).summary.netIncome, -15000);
      await saveExpense(db, finance, create); // lost original response after later edit
      assert.equal((await db.financeExpense.findUniqueOrThrow({ where: { id: create.id } })).amount, 15000);
      await assert.rejects(saveExpense(db, finance, { ...edit, key: randomUUID() }));
      const cancel = { operation: "DELETE", id: create.id, revision: 2, key: randomUUID() };
      await Promise.all([saveExpense(db, finance, cancel), saveExpense(db, finance, cancel)]);
      assert.equal((await listExpenses(db, finance, month)).rows.length, 0);
      assert.equal((await getFinanceReport(db, finance, month)).summary.operatingExpenses, 0);
      assert.equal(await db.auditLog.count({ where: { entityId: create.id } }), 3);
      await assert.rejects(db.financeExpense.delete({ where: { id: create.id } }));
      await assert.rejects(db.financeExpense.update({ where: { id: create.id }, data: { amount: 1, revision: 4 } }));
    });
    await t.test("audit failure rolls back expenses and retry receipt", async () => {
      const broken = new Proxy(db, { get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key);
        return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => db.$transaction(tx => work(new Proxy(tx, { get(client, field) {
          if (field === "auditLog") return { create: async () => { throw new Error("injected audit failure"); } };
          return Reflect.get(client, field);
        } })));
      } });
      const input = request(); await assert.rejects(saveExpense(broken, finance, input));
      assert.equal(await db.financeExpense.count({ where: { id: input.id } }), 0);
      assert.equal(await db.financeExpenseRequest.count({ where: { key: input.key } }), 0);
    });
    await t.test("effective sales/date/void rules, monthly and yearly breakdowns, unknown costs and lifetime", async () => {
      const category = await db.category.create({ data: { name: randomUUID() } });
      const product = await db.product.create({ data: { categoryId: category.id, name: "Coffee", price: 100000 } });
      const shift = await db.shift.create({ data: { cashierId: cashier.id, status: "CLOSED", openingCash: 0, expectedCash: 100000, countedCash: 100000, variance: 0, openedAt: new Date("2042-08-01"), closedAt: new Date("2042-09-01") } });
      const order = await db.order.create({ data: { shiftId: shift.id, cashierId: cashier.id, orderNumber: randomUUID(), createIdempotencyKey: randomUUID(), createRequestFingerprint: "evidence", orderType: "DINE_IN", status: "PAID", total: 100000, paidAt: new Date("2042-08-31T16:59:59.999Z"),
        items: { create: { productId: product.id, productNameSnapshot: "Coffee", unitPriceSnapshot: 100000, quantity: 1, lineTotal: 100000 } },
        payments: { create: { method: "CASH", status: "SUCCEEDED", amount: 100000, cashReceived: 100000, changeAmount: 0, succeededAt: new Date("2042-08-31T16:59:59.999Z"), attemptIdentifier: randomUUID() } } }, include: { items: true, payments: true } });
      const input = { orderId: order.id, expectedRevision: 0, idempotencyKey: randomUUID(), businessDate: "2042-09-01", orderNumber: "Adjusted", channelFee: 10000, items: [{ productName: "Coffee", quantity: 1, unitSellingPrice: 100000, unitHpp: 40000 }] };
      await assert.rejects(adjustTransaction(db, finance, input));
      await adjustTransaction(db, admin, input);
      await saveExpense(db, admin, request());
      const report = await getFinanceReport(db, finance, month);
      assert.equal(report.summary.cashTotal, 100000); assert.equal(report.summary.netIncome, 40000);
      assert.equal(report.breakdown.length, 30); assert.equal(report.breakdown[0].paidSales, 100000);
      assert.equal(report.breakdown.reduce((n, r) => n + r.paidSales, 0), report.summary.paidSales);
      assert.equal(report.breakdown.reduce((n, r) => n + r.operatingExpenses, 0), report.summary.operatingExpenses);
      for (const key of ["paidOrderCount", "cashTotal", "edcTotal", "qrisTotal", "hpp", "grossProfit", "netIncome"] as const) assert.equal(report.breakdown.reduce((n, r) => n + r[key]!, 0), report.summary[key]);
      const yearly = await getFinanceReport(db, finance, { type: "YEAR", value: "2042" });
      assert.equal(yearly.breakdown.length, 12); assert.equal(yearly.breakdown[8].netIncome, 40000);
      assert.equal(yearly.breakdown.reduce((n, r) => n + r.paidSales, 0), yearly.summary.paidSales);
      for (const key of ["paidOrderCount", "cashTotal", "edcTotal", "qrisTotal", "hpp", "grossProfit", "operatingExpenses", "netIncome"] as const) assert.equal(yearly.breakdown.reduce((n, r) => n + r[key]!, 0), yearly.summary[key]);
      assert.equal((await getFinanceReport(db, finance, { type: "DAY", value: "2042-08-31" })).summary.paidSales, 0);
      const moved = { ...input, idempotencyKey: randomUUID(), expectedRevision: 1, businessDate: "2042-10-01", items: [{ ...input.items[0], unitHpp: null }] };
      await adjustTransaction(db, admin, moved);
      assert.equal((await getFinanceReport(db, finance, month)).summary.paidSales, 0);
      const october = await getFinanceReport(db, finance, { type: "MONTH", value: "2042-10" });
      assert.equal(october.summary.netIncome, null); assert.equal(october.summary.hpp, null);
      const voidInput = { businessDate: "2042-10-01", transactions: [{ orderId: order.id, expectedRevision: 2 }] };
      await assert.rejects(voidTransactions(db, finance, voidInput)); await voidTransactions(db, admin, voidInput);
      assert.equal((await getFinanceReport(db, finance, { type: "YEAR", value: "2042" })).summary.paidSales, 0);
      assert.deepEqual(await db.order.findUnique({ where: { id: order.id }, include: { items: true, payments: true } }), order);
      const past = { ...request(), date: "2020-01-01" }; await saveExpense(db, finance, past);
      const lifetime = await getFinanceReport(db, finance, { type: "LIFETIME" });
      assert.equal(lifetime.summary.operatingExpenses, past.amount); // future expenses excluded
      assert.equal(lifetime.period.start, "2019-12-31T17:00:00.000Z");
    });
  } finally { await db.$disconnect(); }
});
