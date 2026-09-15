import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../src/generated/prisma/client";
import { cancelOrder, createOrder, editOrder } from "../src/lib/orders/service";
import { closeShift } from "../src/lib/shifts/service";

test("edit/cancel PostgreSQL transactions, interlocks and concurrency", async (t) => {
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.ok(process.env.DATABASE_URL);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL).hostname));
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const cashier = { id: randomUUID(), role: "CASHIER" as const };
  const admin = { id: randomUUID(), role: "ADMIN" as const };
  const other = { id: randomUUID(), role: "CASHIER" as const };
  const userIds = [cashier.id, admin.id, other.id];
  const categoryId = randomUUID();
  const shiftId = randomUUID();
  const baseline = async () => ({
    users: await db.user.findMany({ orderBy: { id: "asc" } }),
    shifts: await db.shift.findMany({ orderBy: { id: "asc" } }),
    categories: await db.category.findMany({ orderBy: { id: "asc" } }),
    products: await db.product.findMany({ orderBy: { id: "asc" } }),
    orders: await db.order.findMany({ orderBy: { id: "asc" } }),
    items: await db.orderItem.findMany({ orderBy: { id: "asc" } }),
    payments: await db.payment.findMany({ orderBy: { id: "asc" } }),
    audits: await db.auditLog.findMany({ orderBy: { id: "asc" } }),
  });
  const before = await baseline();
  const snapshot = async (id: string) => ({
    order: await db.order.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: { id: "asc" } }, payments: { orderBy: { id: "asc" } } } }),
    audits: await db.auditLog.findMany({ where: { entityId: id }, orderBy: { id: "asc" } }),
    shift: await db.shift.findUniqueOrThrow({ where: { id: shiftId } }),
  });
  function intercept(delegate: "order" | "auditLog" | "shift", method: string, hook: (tx: Prisma.TransactionClient, args: unknown, run: () => Promise<unknown>) => Promise<unknown>) {
    return new Proxy(db, { get(target, key) {
      if (key !== "$transaction") return Reflect.get(target, key);
      return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => db.$transaction((tx) => fn(new Proxy(tx, { get(client, field) {
        if (field !== delegate) return Reflect.get(client, field);
        return new Proxy(tx[delegate], { get(model, operation) {
          const original = Reflect.get(model, operation);
          if (operation !== method) return original;
          return (args: unknown) => hook(tx, args, () => original.call(model, args));
        } });
      } })), { isolationLevel: "ReadCommitted", timeout: 15000 });
    } });
  }
  function gate() {
    let signal!: () => void;
    const promise = new Promise<void>((resolve) => { signal = resolve; });
    return { promise, signal };
  }
  try {
    assert.equal(before.shifts.filter((row) => row.status === "OPEN").length, 0, "Requires idle local register; never modifies real shifts");
    for (const actor of [cashier, admin, other]) await db.user.create({ data: { ...actor, name: "Edit cancel fixture", loginIdentifier: randomUUID(), passwordHash: "unused" } });
    await db.category.create({ data: { id: categoryId, name: "Edit cancel fixture" } });
    await db.shift.create({ data: { id: shiftId, cashierId: cashier.id, openingCash: 0 } });
    const product = await db.product.create({ data: { categoryId, name: "Coffee", price: 25000 } });
    const water = await db.product.create({ data: { categoryId, name: "Water", price: 5000 } });
    const create = (actor = cashier as typeof cashier | typeof admin) => createOrder(db, actor, { createIdempotencyKey: randomUUID(), orderType: "DINE_IN", items: [{ productId: product.id, quantity: 2 }, { productId: water.id, quantity: 1 }] });
    type State = Awaited<ReturnType<typeof create>>;
    const quantity = (order: Pick<State, "id" | "revision" | "items">, value: number) => ({ orderId: order.id, expectedRevision: order.revision,
      operation: { type: "SET_QUANTITY", orderItemId: order.items.find((item) => item.productId === product.id)!.id, quantity: value } });
    const cancellation = (order: Pick<State, "id" | "revision">) => ({ orderId: order.id, expectedRevision: order.revision });
    const add = (order: Pick<State, "id" | "revision">, productId = product.id, count = 1) => ({ ...cancellation(order), operation: { type: "ADD_ITEM", productId, quantity: count } });
    async function rejectsUnchanged(orderId: string, work: () => Promise<unknown>, code: string) {
      const start = await snapshot(orderId);
      await assert.rejects(work(), { code });
      assert.deepEqual(await snapshot(orderId), start);
    }

    await t.test("own shift and admin assistance preserve creator/owner, safe DTO and exact edit audit", async () => {
      for (const creator of [cashier, admin]) {
        const order = await create(creator);
        await rejectsUnchanged(order.id, () => editOrder(db, other, quantity(order, 3)), "FORBIDDEN");
        await rejectsUnchanged(order.id, () => cancelOrder(db, other, cancellation(order)), "FORBIDDEN");
        const updated = await editOrder(db, cashier, quantity(order, 3));
        assert.equal(updated.revision, 2);
        assert.equal(updated.total, 80000);
        assert.equal(updated.cashierId, creator.id);
        assert.equal(updated.shiftId, shiftId);
        assert.deepEqual(Object.keys(updated).sort(), ["id", "orderNumber", "status", "revision", "shiftId", "cashierId", "orderType", "total", "createdAt", "items"].sort());
        const audits = await db.auditLog.findMany({ where: { entityId: order.id, action: "ORDER_UPDATED" } });
        assert.equal(audits.length, 1);
        assert.equal(audits[0].actorId, cashier.id);
        assert.equal(audits[0].entityType, "Order");
        assert.deepEqual(audits[0].details, { orderNumber: order.orderNumber, shiftId, shiftOwnerId: cashier.id, editingActorId: cashier.id,
          revisionBefore: 1, revisionAfter: 2, totalBefore: 55000, totalAfter: 80000, operation: "SET_QUANTITY",
          changedLine: { orderItemId: quantity(order, 3).operation.orderItemId, productId: product.id,
            before: { quantity: 2, lineTotal: 50000 }, after: { quantity: 3, lineTotal: 75000 } } });
        await rejectsUnchanged(order.id, () => editOrder(db, cashier, quantity(order, 3)), "REVISION_CONFLICT");
        await rejectsUnchanged(order.id, () => cancelOrder(db, cashier, cancellation(order)), "REVISION_CONFLICT");
        const assisted = await editOrder(db, admin, quantity(updated, 4));
        const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: order.id, action: "ORDER_UPDATED", actorId: admin.id } });
        assert.equal((audit.details as { editingActorId: string }).editingActorId, admin.id);
        assert.equal((audit.details as { shiftOwnerId: string }).shiftOwnerId, cashier.id);
        assert.equal(assisted.cashierId, creator.id);
        const noopBefore = await snapshot(order.id);
        assert.deepEqual(await editOrder(db, cashier, quantity(assisted, 4)), assisted);
        assert.deepEqual(await snapshot(order.id), noopBefore);
      }
    });

    await t.test("ADD always appends current snapshots; SET preserves historical price/name", async () => {
      const order = await create();
      await db.product.update({ where: { id: product.id }, data: { name: "New coffee", price: 27000 } });
      const added = await editOrder(db, cashier, add(order));
      assert.equal(added.items.length, 3);
      assert.equal(added.total, 82000);
      assert.deepEqual(added.items.find((item) => item.id === quantity(order, 3).operation.orderItemId), order.items.find((item) => item.productId === product.id));
      const newLine = added.items.find((item) => item.unitPrice === 27000)!;
      assert.equal(newLine.productName, "New coffee");
      const again = await editOrder(db, cashier, add(added, product.id, 99));
      assert.equal(again.items.length, 4, "identical snapshots also append, never merge beyond 99");
      const set = await editOrder(db, cashier, quantity(again, 99));
      assert.equal(set.items.find((item) => item.id === quantity(order, 1).operation.orderItemId)!.lineTotal, 2475000);
      assert.equal(set.total, 2475000 + 27000 * 100 + 5000);
      for (const field of ["active", "available"] as const) {
        await db.product.update({ where: { id: product.id }, data: { [field]: false } });
        await rejectsUnchanged(order.id, () => editOrder(db, cashier, add(set)), "PRODUCT_UNAVAILABLE");
        await db.product.update({ where: { id: product.id }, data: { [field]: true } });
      }
      await rejectsUnchanged(order.id, () => editOrder(db, cashier, add(set, randomUUID())), "PRODUCT_NOT_FOUND");
      await db.product.update({ where: { id: product.id }, data: { name: product.name, price: product.price } });
    });

    await t.test("decreases allow sold-out/inactive products; increases reject; invalid/foreign items never mutate", async () => {
      let order: Pick<State, "id" | "revision" | "items"> = await create();
      for (const field of ["active", "available"] as const) {
        await db.product.update({ where: { id: product.id }, data: { [field]: false } });
        await rejectsUnchanged(order.id, () => editOrder(db, cashier, quantity(order, 3)), "PRODUCT_UNAVAILABLE");
        order = await editOrder(db, cashier, quantity(order, 1));
        await db.product.update({ where: { id: product.id }, data: { [field]: true } });
        order = await editOrder(db, cashier, quantity(order, 2));
      }
      const foreign = await create();
      for (const value of [0, -1, 1.5, 100]) await rejectsUnchanged(order.id, () => editOrder(db, cashier, quantity(order, value)), "INVALID_QUANTITY");
      for (const type of ["SET_QUANTITY", "REMOVE_ITEM"]) {
        await rejectsUnchanged(order.id, () => editOrder(db, cashier, { ...cancellation(order), operation: {
          type, orderItemId: foreign.items[0].id, ...(type === "SET_QUANTITY" ? { quantity: 1 } : {}) } }), "ORDER_ITEM_NOT_FOUND");
      }
      const removed = await editOrder(db, cashier, { ...cancellation(order), operation: { type: "REMOVE_ITEM", orderItemId: order.items.find((item) => item.productId === water.id)!.id } });
      assert.equal(removed.items.length, 1);
      assert.equal(removed.total, 50000);
      await rejectsUnchanged(order.id, () => editOrder(db, cashier, { ...cancellation(removed), operation: { type: "REMOVE_ITEM", orderItemId: removed.items[0].id } }), "EMPTY_ORDER_NOT_ALLOWED");
    });

    await t.test("overflow and real audit FK failures roll back all writes and revisions", async () => {
      const order = await create();
      await db.product.update({ where: { id: product.id }, data: { price: 2147483647 } });
      await rejectsUnchanged(order.id, () => editOrder(db, cashier, add(order, product.id, 2)), "MONEY_OVERFLOW");
      await rejectsUnchanged(order.id, () => editOrder(db, cashier, add(order)), "MONEY_OVERFLOW");
      const large = await createOrder(db, cashier, { createIdempotencyKey: randomUUID(), orderType: "TAKEAWAY", items: [{ productId: product.id, quantity: 1 }] });
      await rejectsUnchanged(large.id, () => editOrder(db, cashier, quantity(large, 2)), "MONEY_OVERFLOW");
      await db.product.update({ where: { id: product.id }, data: { price: product.price } });
      const broken = intercept("auditLog", "create", async (tx, args) => {
        const options = args as Prisma.AuditLogCreateArgs;
        const data = options.data as Prisma.AuditLogUncheckedCreateInput;
        return tx.auditLog.create({ ...options, data: { ...data, actorId: randomUUID() } });
      });
      for (const operation of [add(order), quantity(order, 3), { ...cancellation(order), operation: { type: "REMOVE_ITEM", orderItemId: order.items[0].id } }]) {
        await rejectsUnchanged(order.id, () => editOrder(broken, cashier, operation), "UPDATE_FAILED");
      }
      await rejectsUnchanged(order.id, () => cancelOrder(broken, cashier, cancellation(order)), "CANCEL_FAILED");
    });

    await t.test("every payment method blocks PENDING/SUCCEEDED; unsuccessful attempts permit edits and cancellation", async () => {
      for (const method of ["CASH", "BCA_EDC", "MIDTRANS_QRIS"] as const) {
        for (const status of ["PENDING", "SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED"] as const) {
          const order = await create();
          await db.payment.create({ data: { orderId: order.id, method, status, amount: order.total, attemptIdentifier: randomUUID(),
            ...(method === "CASH" && status === "SUCCEEDED" ? { cashReceived: order.total, changeAmount: 0 } : {}),
            succeededAt: status === "SUCCEEDED" ? new Date() : null } });
          if (status === "PENDING" || status === "SUCCEEDED") {
            await rejectsUnchanged(order.id, () => editOrder(db, cashier, quantity(order, 3)), "PAYMENT_BLOCKED");
            await rejectsUnchanged(order.id, () => cancelOrder(db, cashier, cancellation(order)), "PAYMENT_BLOCKED");
          } else {
            const updated = await editOrder(db, cashier, quantity(order, 3));
            assert.equal((await cancelOrder(db, cashier, cancellation(updated))).status, "CANCELLED");
          }
        }
      }
    });

    await t.test("cancellation retains all snapshots/total/ownership and writes one safe audit; terminal orders reject", async () => {
      for (const cancellingActor of [cashier, admin]) {
        const order = await create(admin);
        const start = await snapshot(order.id);
        const cancelled = await cancelOrder(db, cancellingActor, { ...cancellation(order), cancellationReason: "  Customer changed mind 😀  " });
        const after = await snapshot(order.id);
        assert.equal(cancelled.status, "CANCELLED");
        assert.equal(cancelled.revision, 2);
        assert.deepEqual(after.order, { ...start.order, status: "CANCELLED", revision: 2, cancelledAt: after.order.cancelledAt });
        assert.ok(after.order.cancelledAt instanceof Date);
        assert.equal(after.order.paidAt, null);
        assert.deepEqual(after.shift, start.shift);
        const audits = after.audits.filter((audit) => audit.action === "ORDER_CANCELLED");
        assert.equal(audits.length, 1);
        assert.equal(audits[0].actorId, cancellingActor.id);
        assert.deepEqual(audits[0].details, { orderNumber: order.orderNumber, shiftId, shiftOwnerId: cashier.id, cancellingActorId: cancellingActor.id,
          revisionBefore: 1, revisionAfter: 2, total: order.total, cancelledAt: after.order.cancelledAt.toISOString(), reason: "Customer changed mind 😀" });
        await rejectsUnchanged(order.id, () => cancelOrder(db, cancellingActor, cancellation(order)), "ORDER_NOT_EDITABLE");
        await rejectsUnchanged(order.id, () => cancelOrder(db, cancellingActor, cancellation(cancelled)), "ORDER_NOT_EDITABLE");
        await rejectsUnchanged(order.id, () => editOrder(db, cashier, quantity(cancelled, 3)), "ORDER_NOT_EDITABLE");
      }
      const paid = await create();
      await db.order.update({ where: { id: paid.id }, data: { status: "PAID", paidAt: new Date() } });
      await rejectsUnchanged(paid.id, () => editOrder(db, cashier, quantity(paid, 3)), "ORDER_NOT_EDITABLE");
      await rejectsUnchanged(paid.id, () => cancelOrder(db, cashier, cancellation(paid)), "ORDER_NOT_EDITABLE");
    });

    await t.test("concurrent same-revision edits and edit/cancel serialize with exactly one mutation", async () => {
      for (const pair of ["edit-edit", "edit-cancel", "cancel-cancel"]) {
        const order = await create();
        const bothRead = gate(); let reads = 0;
        const racing = intercept("order", "findUnique", async (_tx, args, run) => {
          const found = await run();
          if (Object.keys((args as Prisma.OrderFindUniqueArgs).select!).length === 1) {
            if (++reads === 2) bothRead.signal();
            await bothRead.promise;
          }
          return found;
        });
        const outcomes = await Promise.allSettled([
          pair === "cancel-cancel" ? cancelOrder(racing, cashier, cancellation(order)) : editOrder(racing, cashier, quantity(order, 3)),
          pair === "edit-edit" ? editOrder(racing, admin, quantity(order, 4)) : cancelOrder(racing, admin, cancellation(order)),
        ]);
        assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
        const loser = outcomes.find((result) => result.status === "rejected") as PromiseRejectedResult;
        assert.ok(["REVISION_CONFLICT", "ORDER_NOT_EDITABLE"].includes(loser.reason.code));
        assert.equal((await snapshot(order.id)).order.revision, 2);
        assert.equal(await db.auditLog.count({ where: { entityId: order.id, action: { in: ["ORDER_UPDATED", "ORDER_CANCELLED"] } } }), 1);
      }
    });

    await t.test("mutation holds Shift, Order and Payment locks until commit; close waits and rejects unpaid", async () => {
      const order = await create();
      const payment = await db.payment.create({ data: { orderId: order.id, method: "CASH", status: "FAILED", amount: order.total, attemptIdentifier: randomUUID() } });
      const ready = gate(); const release = gate();
      const paused = intercept("auditLog", "create", async (_tx, _args, run) => { ready.signal(); await release.promise; return run(); });
      const writing = editOrder(paused, cashier, quantity(order, 3));
      const observed = writing.catch(() => undefined);
      let closing: Promise<unknown> | undefined;
      try {
        await Promise.race([ready.promise, writing]);
        await assert.rejects(db.$queryRaw`SELECT id FROM "Shift" WHERE id = ${shiftId}::uuid FOR UPDATE NOWAIT`, /could not obtain lock/);
        await assert.rejects(db.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id}::uuid FOR UPDATE NOWAIT`, /could not obtain lock/);
        await assert.rejects(db.$queryRaw`SELECT id FROM "Payment" WHERE id = ${payment.id}::uuid FOR UPDATE NOWAIT`, /could not obtain lock/);
        closing = assert.rejects(closeShift(db, cashier, { shiftId, countedCash: 0 }), { code: "UNRESOLVED_TRANSACTIONS" });
        release.signal(); await writing; await closing;
      } finally { release.signal(); await observed; await closing; }
    });

    await t.test("waiting mutations observe CLOSED persisted shift, even after a new OPEN shift exists", async () => {
      const order = await create();
      // Fixture-only closure permits exercising the post-lock recheck on an unpaid order.
      const ready = gate(); const release = gate(); const discovered = gate(); let reads = 0;
      const closing = db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Shift" WHERE id = ${shiftId}::uuid FOR UPDATE`;
        ready.signal(); await release.promise;
        await tx.shift.update({ where: { id: shiftId }, data: { status: "CLOSED", closedAt: new Date() } });
      }, { timeout: 15000 });
      const observed = closing.catch(() => undefined);
      let outcomes: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await Promise.race([ready.promise, closing]);
        const waiting = intercept("order", "findUnique", async (_tx, args, run) => {
          const found = await run();
          if (Object.keys((args as Prisma.OrderFindUniqueArgs).select!).length === 1 && ++reads === 2) discovered.signal();
          return found;
        });
        outcomes = Promise.allSettled([editOrder(waiting, cashier, quantity(order, 3)), cancelOrder(waiting, admin, cancellation(order))]);
        await Promise.race([discovered.promise, outcomes]);
        release.signal(); await closing;
        for (const outcome of await outcomes) {
          assert.equal(outcome.status, "rejected");
          assert.equal((outcome as PromiseRejectedResult).reason.code, "NO_ACTIVE_SHIFT");
        }
      } finally { release.signal(); await observed; await outcomes; }
      const newShift = await db.shift.create({ data: { cashierId: admin.id, openingCash: 0 } });
      await rejectsUnchanged(order.id, () => editOrder(db, admin, quantity(order, 3)), "NO_ACTIVE_SHIFT");
      await rejectsUnchanged(order.id, () => cancelOrder(db, admin, cancellation(order)), "NO_ACTIVE_SHIFT");
      const own = await create(admin);
      const changed = await editOrder(db, admin, quantity(own, 3));
      assert.equal(changed.shiftId, newShift.id);
      assert.equal((await cancelOrder(db, admin, cancellation(changed))).status, "CANCELLED");
    });
  } finally {
    await db.$transaction(async (tx) => {
      await tx.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
      await tx.payment.deleteMany({ where: { order: { cashierId: { in: userIds } } } });
      await tx.orderItem.deleteMany({ where: { order: { cashierId: { in: userIds } } } });
      await tx.order.deleteMany({ where: { cashierId: { in: userIds } } });
      await tx.shift.deleteMany({ where: { cashierId: { in: userIds } } });
      await tx.product.deleteMany({ where: { categoryId } });
      await tx.category.deleteMany({ where: { id: categoryId } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
    });
    try {
      assert.deepEqual(await baseline(), before, "All preexisting development rows restored exactly");
      const [sequence] = await db.$queryRaw<{ last_value: bigint }[]>`SELECT last_value FROM order_number_seq`;
      t.diagnostic(`Development rows restored; order_number_seq last_value=${sequence.last_value} (never reset)`);
    } finally { await db.$disconnect(); }
  }
});
