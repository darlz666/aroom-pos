import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../src/generated/prisma/client";
import { adjustTransaction, voidTransactions } from "../src/lib/reports/adjustment-service";
import { getDailyReport } from "../src/lib/reports/service";
import { getReportReceipt } from "../src/lib/orders/receipt";
import { getShiftSettlement } from "../src/lib/shifts/settlement";

test("append-only financial overrides, effective dates, atomic voids, concurrency and original evidence", async t => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.match(url.pathname, /^\/aroom_(access|payment|report)_test_/);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  const actors = await Promise.all((["ADMIN", "CASHIER", "FINANCE"] as const).map(role => db.user.create({ data: { role, name: role, loginIdentifier: randomUUID(), passwordHash: "unused" } })));
  const [admin, cashier, finance] = actors;
  const category = await db.category.create({ data: { name: randomUUID() } });
  const product = await db.product.create({ data: { categoryId: category.id, name: "Original Coffee", price: 22000 } });
  const shift = await db.shift.create({ data: { cashierId: cashier.id, status: "CLOSED", openingCash: 10000, expectedCash: 76000,
    countedCash: 75000, variance: -1000, closingNote: "Original", openedAt: new Date("2040-01-01T17:00:00Z"), closedAt: new Date("2040-01-02T17:00:00Z") } });
  const ingredient = await db.ingredient.create({ data: { name: randomUUID(), baseUnit: "g", currentStock: "90" } });
  const orders = [];
  for (const method of ["CASH", "BCA_EDC", "MIDTRANS_QRIS"] as const) {
    const order = await db.order.create({ data: { shiftId: shift.id, cashierId: cashier.id, orderNumber: randomUUID(), createIdempotencyKey: randomUUID(), createRequestFingerprint: "original",
      orderType: "DINE_IN", status: "PAID", total: 22000, paidAt: new Date("2040-01-01T17:05:01.123Z"),
      items: { create: { productId: product.id, productNameSnapshot: product.name, unitPriceSnapshot: 22000, quantity: 1, lineTotal: 22000 } },
      payments: { create: { method, status: "SUCCEEDED", amount: 22000, succeededAt: new Date("2040-01-01T17:05:01.123Z"), attemptIdentifier: randomUUID(),
        ...(method === "CASH" ? { cashReceived: 25000, changeAmount: 3000 } : {}) } },
    }, include: { payments: true } });
    await db.stockMovement.create({ data: { ingredientId: ingredient.id, type: "SALE_CONSUMPTION", quantity: "1", unit: "g", stockAfter: "90", paymentId: order.payments[0].id, sourceType: "Payment", sourceId: order.payments[0].id, actorId: cashier.id } });
    orders.push(order);
  }
  const ids = orders.map(row => row.id);
  const evidence = async () => ({
    orders: await db.order.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" }, include: { items: true, payments: true } }),
    shift: await db.shift.findUnique({ where: { id: shift.id } }), stock: await db.ingredient.findUnique({ where: { id: ingredient.id } }),
    movements: await db.stockMovement.findMany({ where: { ingredientId: ingredient.id }, orderBy: { id: "asc" } }),
    receipt: await getReportReceipt(db, admin, ids[0]), settlement: await getShiftSettlement(db, shift.id),
  });
  const before = await evidence();
  const request = (orderId = ids[0], revision = 0) => ({ orderId, expectedRevision: revision, idempotencyKey: randomUUID(), businessDate: "2040-01-03", orderNumber: "Adjusted display",
    channelFee: 500, items: [{ productName: "Adjusted Coffee", quantity: 1, unitSellingPrice: 25000, unitHpp: 12950 }] });
  const voidRequest = (orderIds: string[], revision = 0, businessDate = "2040-01-02") => ({ businessDate, transactions: orderIds.map(orderId => ({ orderId, expectedRevision: revision })) });
  const report = (date: string) => getDailyReport(db, admin, date);
  try {
    await t.test("fresh role authorization rejects forged, inactive and non-admin writes", async () => {
      for (const actor of [cashier, finance, { ...cashier, role: "ADMIN" as const }]) {
        await assert.rejects(adjustTransaction(db, actor, request()), { code: "FORBIDDEN" });
        await assert.rejects(voidTransactions(db, actor, voidRequest(ids)), { code: "FORBIDDEN" });
      }
      await db.user.update({ where: { id: admin.id }, data: { active: false } });
      await assert.rejects(adjustTransaction(db, admin, request()), { code: "FORBIDDEN" });
      await db.user.update({ where: { id: admin.id }, data: { active: true } });
    });
    await t.test("identical concurrent retries append once; latest override moves dates and changes summaries", async () => {
      const input = request();
      const results = await Promise.all([adjustTransaction(db, admin, input), adjustTransaction(db, admin, input)]);
      assert.equal(results.filter(row => row.replayed).length, 1);
      assert.equal(await db.transactionAdjustment.count({ where: { orderId: ids[0] } }), 1);
      assert.equal(await db.auditLog.count({ where: { entityId: ids[0], action: "TRANSACTION_ADJUSTED" } }), 1);
      await assert.rejects(adjustTransaction(db, admin, { ...input, orderNumber: "different" }), { code: "CONFLICT" });
      assert.equal((await report("2040-01-02")).paidSales, 44000);
      const effective = await report("2040-01-03");
      assert.equal(effective.paidSales, 25000); assert.equal(effective.cashTotal, 25000); assert.equal(effective.paidOrderCount, 1);
      assert.equal(effective.transactions[0].paidAt, "2040-01-02T17:05:01.123Z");
      assert.equal(effective.transactions[0].sellingPrice, 25000); assert.equal(effective.transactions[0].totalRevenue, 25000);
      assert.equal(effective.transactions[0].channelFee, 500); assert.equal(effective.transactions[0].totalDeductions, 500);
      assert.equal(effective.transactions[0].hpp, 12950); assert.equal(effective.transactions[0].grossProfit, 12050);
      assert.equal(effective.transactions[0].netRevenue, 11550);
      const next = { ...request(ids[0], 1), businessDate: "2040-01-04", items: [{ productName: "Unknown cost", quantity: 1, unitSellingPrice: 10000, unitHpp: null }] };
      const race = await Promise.allSettled([adjustTransaction(db, admin, next), adjustTransaction(db, admin, { ...next, idempotencyKey: randomUUID() })]);
      assert.equal(race.filter(row => row.status === "fulfilled").length, 1);
      assert.equal((await report("2040-01-03")).paidOrderCount, 0);
      assert.equal((await report("2040-01-04")).transactions[0].hpp, null);
      assert.equal((await report("2040-01-04")).paidSales, 10000);
      assert.equal((await report("2040-01-04")).transactions[0].channelFee, 500);
      assert.equal((await report("2040-01-04")).transactions[0].grossProfit, null);
      assert.equal((await report("2040-01-04")).transactions[0].netRevenue, null);
      assert.equal(await db.transactionAdjustment.count({ where: { orderId: ids[0] } }), 2);
    });
    await t.test("append-only headers, items and void records reject updates and deletes", async () => {
      const saved = await db.transactionAdjustment.findFirstOrThrow({ where: { orderId: ids[0] }, include: { items: true } });
      await assert.rejects(db.transactionAdjustment.update({ where: { id: saved.id }, data: { orderNumber: "overwrite" } }));
      await assert.rejects(db.transactionAdjustment.delete({ where: { id: saved.id } }));
      await assert.rejects(db.transactionAdjustmentItem.update({ where: { id: saved.items[0].id }, data: { quantity: 5 } }));
      await assert.rejects(db.transactionAdjustmentItem.delete({ where: { id: saved.items[0].id } }));
      await assert.rejects(db.transactionAdjustmentItem.create({ data: { adjustmentId: saved.id, position: 99, productName: "Late insert", quantity: 1, unitSellingPrice: 0 } }));
    });
    await t.test("bulk rollback on stale row or audit failure; repeated bulk submissions record once", async () => {
      await assert.rejects(voidTransactions(db, admin, voidRequest(ids)), { code: "CONFLICT" });
      assert.equal(await db.transactionVoid.count({ where: { orderId: { in: ids } } }), 0);
      const broken = new Proxy(db, { get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key);
        return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => db.$transaction(tx => work(new Proxy(tx, { get(client, field) {
          if (field === "auditLog") return { create: async () => { throw new Error("injected failure"); } };
          return Reflect.get(client, field);
        } })));
      } });
      await assert.rejects(voidTransactions(broken, admin, voidRequest(ids.slice(1))));
      assert.equal(await db.transactionVoid.count({ where: { orderId: { in: ids } } }), 0);
      await assert.rejects(adjustTransaction(broken, admin, request(ids[1])));
      assert.equal(await db.transactionAdjustment.count({ where: { orderId: ids[1] } }), 0);
      const duplicateBulk = voidRequest([ids[2], ids[1], ids[2]]);
      await Promise.all([voidTransactions(db, admin, duplicateBulk), voidTransactions(db, admin, duplicateBulk)]);
      const empty = await report("2040-01-02");
      assert.equal(empty.paidSales, 0); assert.equal(empty.edcTotal, 0); assert.equal(empty.qrisTotal, 0); assert.deepEqual(empty.transactions, []);
      assert.equal(await db.auditLog.count({ where: { entityId: { in: ids }, action: "TRANSACTION_VOIDED" } }), 2);
      await voidTransactions(db, admin, voidRequest([ids[0]], 2, "2040-01-04"));
      assert.equal((await report("2040-01-04")).paidOrderCount, 0);
      await assert.rejects(voidTransactions(db, admin, voidRequest([ids[0]], 1, "2040-01-04")), { code: "CONFLICT" });
      await assert.rejects(voidTransactions(db, admin, voidRequest([ids[0]], 2, "2040-01-03")), { code: "CONFLICT" });
      await assert.rejects(adjustTransaction(db, admin, request(ids[0], 2)), { code: "VOIDED" });
      const saved = await db.transactionVoid.findUniqueOrThrow({ where: { orderId: ids[0] } });
      await assert.rejects(db.transactionVoid.update({ where: { id: saved.id }, data: { reason: "overwrite" } }));
      await assert.rejects(db.transactionVoid.delete({ where: { id: saved.id } }));
      assert.deepEqual(await evidence(), before);
    });
  } finally {
    // Cleanup only our fixtures in the required disposable test database.
    await db.$transaction(async tx => {
      for (const table of ["TransactionAdjustmentItem", "TransactionAdjustment", "TransactionVoid", "StockMovement"]) await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${table}_immutable"`);
      await tx.transactionAdjustmentItem.deleteMany({ where: { adjustment: { orderId: { in: ids } } } });
      await tx.transactionAdjustment.deleteMany({ where: { orderId: { in: ids } } });
      await tx.transactionVoid.deleteMany({ where: { orderId: { in: ids } } });
      await tx.stockMovement.deleteMany({ where: { ingredientId: ingredient.id } });
      for (const table of ["TransactionAdjustmentItem", "TransactionAdjustment", "TransactionVoid", "StockMovement"]) await tx.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${table}_immutable"`);
      await tx.auditLog.deleteMany({ where: { actorId: { in: actors.map(actor => actor.id) } } });
      await tx.payment.deleteMany({ where: { orderId: { in: ids } } });
      await tx.orderItem.deleteMany({ where: { orderId: { in: ids } } });
      await tx.order.deleteMany({ where: { id: { in: ids } } });
      await tx.shift.delete({ where: { id: shift.id } });
      await tx.product.delete({ where: { id: product.id } });
      await tx.category.delete({ where: { id: category.id } });
      await tx.ingredient.delete({ where: { id: ingredient.id } });
      await tx.user.deleteMany({ where: { id: { in: actors.map(actor => actor.id) } } });
    });
    await db.$disconnect();
  }
});
