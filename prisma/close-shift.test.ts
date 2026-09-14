import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma, type PaymentMethod, type PaymentStatus } from "../src/generated/prisma/client";
import { closeShift, withOperableShift } from "../src/lib/shifts/service";

test("close shift PostgreSQL reconciliation, atomicity and locking with restored fixtures", async (t) => {
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.ok(process.env.DATABASE_URL);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const rollback = new Error("rollback fixtures");
  try {
    const users = await db.user.findMany({ where: { active: true }, select: { id: true, role: true } });
    const cashier = users.find((u) => u.role === "CASHIER");
    const admin = users.find((u) => u.role === "ADMIN");
    assert.ok(cashier && admin, "Requires active development CASHIER and ADMIN");
    const before = await db.shift.findMany({ where: { status: "OPEN" } });

    await t.test("persisted payment filters, blockers, permissions, immutable close and audit", async () => {
      await assert.rejects(db.$transaction(async (tx) => {
        await tx.$executeRaw`LOCK TABLE "Shift" IN EXCLUSIVE MODE`;
        await tx.shift.updateMany({ where: { status: "OPEN" }, data: { status: "CLOSED" } });
        let cashQuery: Prisma.PaymentAggregateArgs | undefined;
        const observed = new Proxy(tx, { get(target, key) {
          if (key !== "payment") return Reflect.get(target, key);
          return new Proxy(tx.payment, { get(delegate, method) {
            if (method === "aggregate") return (args: Prisma.PaymentAggregateArgs) => {
              cashQuery = args;
              return delegate.aggregate(args);
            };
            return Reflect.get(delegate, method);
          } });
        } });
        const scoped = { $transaction: (fn: (client: Prisma.TransactionClient) => unknown) => fn(observed) } as unknown as PrismaClient;
        for (const actor of [cashier, admin]) {
          const shift = await tx.shift.create({ data: { cashierId: actor.id, openingCash: 0 } });
          assert.equal((await closeShift(scoped, actor, { shiftId: shift.id, countedCash: 0 })).cashVariance, 0);
        }
        const shift = await tx.shift.create({ data: { cashierId: cashier.id, openingCash: 100 } });
        const otherShift = await tx.shift.create({ data: { cashierId: cashier.id, openingCash: 0, status: "CLOSED" } });
        const addPayment = async (method: PaymentMethod, status: PaymentStatus, amount: number, target = shift.id) => {
          const order = await tx.order.create({ data: {
            createIdempotencyKey: randomUUID(), createRequestFingerprint: "close-shift-fixture",
            ...(status === "SUCCEEDED" ? { paidAt: new Date() } : { cancelledAt: new Date() }),
            shiftId: target, cashierId: cashier.id, orderNumber: `close-test-${randomUUID()}`,
            orderType: "TAKEAWAY", status: status === "SUCCEEDED" ? "PAID" : "CANCELLED", total: amount + 7,
          } });
          // Deliberately different total/tender values prove reconciliation uses Payment.amount.
          return tx.payment.create({ data: {
            orderId: order.id, method, status, amount, attemptIdentifier: randomUUID(),
            ...(method === "CASH" ? { cashReceived: amount + 1000, changeAmount: 1000 } : {}),
          } });
        };
        await addPayment("CASH", "SUCCEEDED", 200);
        await addPayment("CASH", "SUCCEEDED", 300);
        await addPayment("BCA_EDC", "SUCCEEDED", 400);
        await addPayment("MIDTRANS_QRIS", "SUCCEEDED", 500);
        for (const status of ["FAILED", "EXPIRED", "CANCELLED"] as const) await addPayment("CASH", status, 600);
        await addPayment("CASH", "SUCCEEDED", 999, otherShift.id);
        const unpaid = await tx.order.create({ data: {
          createIdempotencyKey: randomUUID(), createRequestFingerprint: "close-shift-fixture",
          shiftId: shift.id, cashierId: cashier.id, orderNumber: randomUUID(), orderType: "DINE_IN", total: 10,
        } });
        const input = { shiftId: shift.id, countedCash: 600 };
        const rejectUnchanged = async (code: string, action: () => Promise<unknown>) => {
          const orders = await tx.order.findMany({ orderBy: { id: "asc" } });
          const payments = await tx.payment.findMany({ orderBy: { id: "asc" } });
          await assert.rejects(action(), { code });
          assert.deepEqual(await tx.shift.findUnique({ where: { id: shift.id } }), shift);
          assert.deepEqual(await tx.order.findMany({ orderBy: { id: "asc" } }), orders);
          assert.deepEqual(await tx.payment.findMany({ orderBy: { id: "asc" } }), payments);
          assert.equal(await tx.auditLog.count({ where: { entityId: shift.id } }), 0);
        };
        await rejectUnchanged("FORBIDDEN", () => closeShift(scoped, { ...cashier, id: admin.id }, input));
        await rejectUnchanged("UNRESOLVED_TRANSACTIONS", () => closeShift(scoped, cashier, input));
        await tx.order.update({ where: { id: unpaid.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
        for (const method of ["CASH", "BCA_EDC", "MIDTRANS_QRIS"] as const) {
          const pending = await addPayment(method, "PENDING", 700);
          await rejectUnchanged("UNRESOLVED_TRANSACTIONS", () => closeShift(scoped, cashier, input));
          // Reuse the service's actual aggregate query captured from the zero-cash
          // closes above, scoped to this fixture. Pending cash cannot be included
          // in a saved close because the blocker correctly stops it first.
          assert.ok(cashQuery);
          const cash = await tx.payment.aggregate({ ...cashQuery,
            where: { ...cashQuery.where, order: { shiftId: shift.id } },
          });
          assert.equal(cash._sum?.amount, 500);
          await tx.payment.update({ where: { id: pending.id }, data: { status: "FAILED" } });
        }
        for (const reason of [undefined, "", " \n"]) {
          await rejectUnchanged("REASON_REQUIRED", () => closeShift(scoped, admin, { ...input, adminCloseReason: reason }));
        }
        await rejectUnchanged("DISCREPANCY_NOTE_REQUIRED", () => closeShift(scoped, cashier, { ...input, countedCash: 590 }));
        const orders = await tx.order.findMany({ orderBy: { id: "asc" } });
        const payments = await tx.payment.findMany({ orderBy: { id: "asc" } });
        const result = await closeShift(scoped, admin, { ...input, countedCash: 590, discrepancyNote: " short ten ", adminCloseReason: " covering owner " });
        assert.equal(result.expectedCash, 600);
        assert.equal(result.cashVariance, -10);
        const closed = await tx.shift.findUniqueOrThrow({ where: { id: shift.id } });
        assert.equal(closed.cashierId, cashier.id);
        assert.equal(closed.status, "CLOSED");
        assert.equal(closed.countedCash, 590);
        assert.equal(closed.expectedCash, 600);
        assert.equal(closed.variance, -10);
        assert.equal(closed.closingNote, "short ten");
        assert.ok(closed.closedAt);
        const audits = await tx.auditLog.findMany({ where: { entityId: shift.id } });
        assert.equal(audits.length, 1);
        assert.equal(audits[0].action, "SHIFT_CLOSED");
        assert.equal(audits[0].actorId, admin.id);
        assert.deepEqual(audits[0].details, {
          shiftOwnerId: cashier.id, closingActorId: admin.id, expectedCash: 600, countedCash: 590,
          variance: -10, adminClosedOtherOwner: true, discrepancyNote: "short ten", adminCloseReason: "covering owner",
        });
        await assert.rejects(closeShift(scoped, admin, { ...input, adminCloseReason: "retry" }), { code: "SHIFT_NOT_OPEN" });
        await assert.rejects(closeShift(scoped, admin, { ...input, shiftId: randomUUID() }), { code: "SHIFT_NOT_OPEN" });
        assert.deepEqual(await tx.shift.findUnique({ where: { id: shift.id } }), closed);
        assert.deepEqual(await tx.order.findMany({ orderBy: { id: "asc" } }), orders);
        assert.deepEqual(await tx.payment.findMany({ orderBy: { id: "asc" } }), payments);
        throw rollback;
      }, { timeout: 15000 }), (error: unknown) => error === rollback);
      assert.deepEqual(await db.shift.findMany({ where: { status: "OPEN" } }), before);
    });

    await t.test("real transaction rollback on audit insertion failure", async () => {
      const id = randomUUID();
      const failure = new Error("audit insertion failed");
      let reachedAudit = false;
      const scoped = { $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => db.$transaction(async (tx) => {
        await tx.$executeRaw`LOCK TABLE "Shift" IN EXCLUSIVE MODE`;
        await tx.shift.updateMany({ where: { status: "OPEN" }, data: { status: "CLOSED" } });
        await tx.shift.create({ data: { id, cashierId: cashier.id, openingCash: 0 } });
        return fn(new Proxy(tx, { get(target, key) {
          if (key === "auditLog") return { create: async () => {
            assert.equal((await tx.shift.findUniqueOrThrow({ where: { id } })).status, "CLOSED");
            reachedAudit = true;
            throw failure;
          } };
          return Reflect.get(target, key);
        } }));
      }) } as unknown as PrismaClient;
      await assert.rejects(closeShift(scoped, cashier, { shiftId: id, countedCash: 0 }), (error: unknown) => error === failure);
      assert.equal(reachedAudit, true);
      assert.equal(await db.shift.count({ where: { id } }), 0);
      assert.equal(await db.auditLog.count({ where: { entityId: id } }), 0);
      assert.deepEqual(await db.shift.findMany({ where: { status: "OPEN" } }), before);
    });

    await t.test("competing closes and Shift-first writers serialize against committed state", async () => {
      assert.equal(before.length, 0, "Requires idle development register; existing shifts are never removed");
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      try {
        const first = await db.shift.create({ data: { id: ids[0], cashierId: cashier.id, openingCash: 0 } });
        const closes = await Promise.allSettled([
          closeShift(db, cashier, { shiftId: first.id, countedCash: 0 }),
          closeShift(db, cashier, { shiftId: first.id, countedCash: 0 }),
        ]);
        assert.equal(closes.filter((r) => r.status === "fulfilled").length, 1);
        const rejected = closes.find((r) => r.status === "rejected");
        assert.ok(rejected && rejected.status === "rejected");
        assert.equal(rejected.reason.code, "SHIFT_NOT_OPEN");
        assert.equal(await db.auditLog.count({ where: { entityId: first.id, action: "SHIFT_CLOSED" } }), 1);

        // Pause a close after reconciliation while it still owns the row lock.
        const second = await db.shift.create({ data: { id: ids[1], cashierId: cashier.id, openingCash: 0 } });
        let reconciled!: () => void;
        const ready = new Promise<void>((resolve) => { reconciled = resolve; });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const paused = { $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => db.$transaction((tx) => fn(new Proxy(tx, { get(target, key) {
          if (key !== "shift") return Reflect.get(target, key);
          return new Proxy(tx.shift, { get(delegate, method) {
            if (method === "update") return async (args: Prisma.ShiftUpdateArgs) => {
              reconciled();
              await gate;
              return delegate.update(args);
            };
            return Reflect.get(delegate, method);
          } });
        } })), { timeout: 10000 }) } as unknown as PrismaClient;
        const closing = closeShift(paused, cashier, { shiftId: second.id, countedCash: 0 });
        // Attach rejection handling immediately so a failure cannot become unhandled.
        const closeOutcome = closing.then(() => null, (error: unknown) => error);
        await Promise.race([ready, closing]);
        try {
          // A separate connection proves the close still holds the lock after its sum.
          await assert.rejects(db.$queryRaw`SELECT "id" FROM "Shift" WHERE "id" = ${second.id}::uuid FOR UPDATE NOWAIT`, /could not obtain lock/);
        } catch (error) {
          release();
          await closeOutcome;
          throw error;
        }
        let writeReached = false;
        const writer = withOperableShift(db, cashier, second.id, async () => { writeReached = true; });
        const outcomes = Promise.allSettled([closing, writer]);
        release();
        const results = await outcomes;
        assert.equal(await closeOutcome, null);
        assert.equal(results[0].status, "fulfilled");
        assert.equal(results[1].status, "rejected");
        if (results[1].status === "rejected") assert.equal(results[1].reason.code, "SHIFT_NOT_OPEN");
        assert.equal(writeReached, false);

        // Conversely, an earlier compliant writer's committed UNPAID order blocks close.
        const third = await db.shift.create({ data: { id: ids[2], cashierId: cashier.id, openingCash: 0 } });
        let writerLocked!: () => void;
        const locked = new Promise<void>((resolve) => { writerLocked = resolve; });
        let releaseWriter!: () => void;
        const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; });
        const writing = withOperableShift(db, cashier, third.id, async (tx) => {
          writerLocked();
          await writerGate;
          await tx.order.create({ data: { createIdempotencyKey: randomUUID(), createRequestFingerprint: "close-shift-fixture", shiftId: third.id, cashierId: cashier.id, orderNumber: randomUUID(), orderType: "TAKEAWAY", total: 10 } });
        });
        const writeOutcome = writing.then(() => null, (error: unknown) => error);
        await Promise.race([locked, writing]);
        const waitingClose = closeShift(db, cashier, { shiftId: third.id, countedCash: 0 });
        const both = Promise.allSettled([writing, waitingClose]);
        releaseWriter();
        const completed = await both;
        assert.equal(await writeOutcome, null);
        assert.equal(completed[1].status, "rejected");
        if (completed[1].status === "rejected") assert.equal(completed[1].reason.code, "UNRESOLVED_TRANSACTIONS");
        assert.equal((await db.shift.findUniqueOrThrow({ where: { id: third.id } })).status, "OPEN");
      } finally {
        await db.$transaction(async (tx) => {
          await tx.auditLog.deleteMany({ where: { entityId: { in: ids }, action: "SHIFT_CLOSED" } });
          await tx.order.deleteMany({ where: { shiftId: { in: ids } } });
          await tx.shift.deleteMany({ where: { id: { in: ids } } });
        });
      }
      assert.equal(await db.shift.count({ where: { id: { in: ids } } }), 0);
      assert.deepEqual(await db.shift.findMany({ where: { status: "OPEN" } }), before);
    });
  } finally { await db.$disconnect(); }
});
