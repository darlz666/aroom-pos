import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../src/generated/prisma/client";
import { createOrder } from "../src/lib/orders/service";
import { closeShift } from "../src/lib/shifts/service";

test("create order PostgreSQL behavior and concurrency; isolated fixtures restored", async (t) => {
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.ok(process.env.DATABASE_URL);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL).hostname));
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const userIds = [randomUUID(), randomUUID(), randomUUID()];
  const categoryId = randomUUID();
  const shiftIds: string[] = [];
  const cashier = { id: userIds[0], role: "CASHIER" as const };
  const admin = { id: userIds[1], role: "ADMIN" as const };
  const other = { id: userIds[2], role: "CASHIER" as const };
  const baseline = async () => ({
    users: await db.user.findMany({ orderBy: { id: "asc" } }),
    shifts: await db.shift.findMany({ orderBy: { id: "asc" } }),
    products: await db.product.findMany({ orderBy: { id: "asc" } }),
    categories: await db.category.findMany({ orderBy: { id: "asc" } }),
    orders: await db.order.findMany({ orderBy: { id: "asc" } }),
    items: await db.orderItem.findMany({ orderBy: { id: "asc" } }),
    audits: await db.auditLog.findMany({ orderBy: { id: "asc" } }),
    payments: await db.payment.findMany({ orderBy: { id: "asc" } }),
  });
  const before = await baseline();
  const counts = async () => [await db.order.count(), await db.orderItem.count(), await db.auditLog.count()];
  const sequence = async () => (await db.$queryRaw<{ last_value: bigint }[]>`SELECT last_value FROM order_number_seq`)[0].last_value;
  // Intercept one delegate method while retaining actual PostgreSQL transactions.
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
  const newShift = async (owner: { id: string } = cashier) => {
    const id = randomUUID();
    shiftIds.push(id);
    return db.shift.create({ data: { id, cashierId: owner.id, openingCash: 0 } });
  };
  // Database fixture lifecycle changes only; no edit/cancel service is implemented.
  const retire = (id: string) => db.shift.update({ where: { id }, data: { status: "CLOSED", closedAt: new Date() } });
  function gate() {
    let signal!: () => void;
    const promise = new Promise<void>((resolve) => { signal = resolve; });
    return { promise, signal };
  }
  try {
    assert.equal(before.shifts.filter((shift) => shift.status === "OPEN").length, 0, "Requires idle register; never closes a real development shift");
    await db.$transaction(async (tx) => {
      for (const actor of [cashier, admin, other]) await tx.user.create({ data: { ...actor, name: "Create order fixture", loginIdentifier: randomUUID(), passwordHash: "unused" } });
      await tx.category.create({ data: { id: categoryId, name: "Create order fixture" } });
    });
    const product = await db.product.create({ data: { categoryId, name: "Fixture coffee", price: 22000 } });
    const second = await db.product.create({ data: { categoryId, name: "Fixture water", price: 5000 } });
    const request = () => ({ createIdempotencyKey: randomUUID(), orderType: "DINE_IN" as const, items: [{ productId: product.id, quantity: 2 }, { productId: second.id, quantity: 1 }] });

    await t.test("no active shift rejects without writes", async () => {
      const start = await counts();
      await assert.rejects(createOrder(db, cashier, request()), { code: "NO_ACTIVE_SHIFT" });
      assert.deepEqual(await counts(), start);
    });
    const shift = await newShift();
    await t.test("cashier ownership, admin assistance, authority, snapshots, audit and sequence", async () => {
      await assert.rejects(createOrder(db, other, request()), { code: "FORBIDDEN" });
      const input = request();
      const created = await createOrder(db, cashier, input);
      assert.equal(created.status, "UNPAID");
      assert.equal(created.revision, 1);
      assert.equal(created.total, 49000);
      assert.equal(created.shiftId, shift.id);
      assert.equal(created.cashierId, cashier.id);
      assert.equal(created.replayed, false);
      assert.match(created.orderNumber, /^AR-\d{6,}$/);
      const row = await db.order.findUniqueOrThrow({ where: { id: created.id } });
      assert.equal(row.paidAt, null);
      assert.equal(row.cancelledAt, null);
      assert.equal(row.createIdempotencyKey, input.createIdempotencyKey);
      const audits = await db.auditLog.findMany({ where: { entityId: created.id } });
      assert.equal(audits.length, 1);
      assert.equal(audits[0].actorId, cashier.id);
      assert.equal(audits[0].action, "ORDER_CREATED");
      assert.equal(audits[0].entityType, "Order");
      assert.deepEqual(audits[0].details, { orderNumber: created.orderNumber, shiftId: shift.id, shiftOwnerId: cashier.id,
        creatorId: cashier.id, orderType: "DINE_IN", revision: 1, total: 49000,
        items: created.items.map((item) => ({ productId: item.productId, productNameSnapshot: item.productName, unitPriceSnapshot: item.unitPrice, quantity: item.quantity, lineTotal: item.lineTotal })) });
      const assistance = await createOrder(db, admin, request());
      assert.equal(assistance.cashierId, admin.id);
      assert.equal((await db.shift.findUniqueOrThrow({ where: { id: shift.id } })).cashierId, cashier.id);
      const adminAudit = await db.auditLog.findFirstOrThrow({ where: { entityId: assistance.id } });
      assert.equal(adminAudit.actorId, admin.id);
      assert.equal((adminAudit.details as { shiftOwnerId: string }).shiftOwnerId, cashier.id);
      assert.ok(BigInt(assistance.orderNumber.slice(3)) > BigInt(created.orderNumber.slice(3)));
      const last = await sequence();
      await db.product.update({ where: { id: product.id }, data: { name: "Changed", price: 99, active: false, available: false } });
      await retire(shift.id);
      const recovered = await createOrder(db, cashier, { ...input, items: [{ productId: second.id, quantity: 1 }, { productId: product.id, quantity: 1 }, { productId: product.id, quantity: 1 }] });
      assert.deepEqual(recovered, { ...created, replayed: true });
      assert.equal(await sequence(), last, "Replay consumes no sequence value");
      assert.equal(await db.auditLog.count({ where: { entityId: created.id } }), 1);
      await assert.rejects(createOrder(db, cashier, { ...input, orderType: "TAKEAWAY" }), { code: "IDEMPOTENCY_CONFLICT" });
      await assert.rejects(createOrder(db, cashier, { ...input, items: [{ productId: product.id, quantity: 3 }] }), { code: "IDEMPOTENCY_CONFLICT" });
      await assert.rejects(createOrder(db, admin, input), { code: "IDEMPOTENCY_CONFLICT" });
      await assert.rejects(createOrder(db, cashier, request()), { code: "NO_ACTIVE_SHIFT" });
      await db.product.update({ where: { id: product.id }, data: { name: product.name, price: product.price, active: true, available: true } });
    });
    const adminShift = await newShift(admin);
    await t.test("admin own shift accepted", async () => {
      assert.equal((await createOrder(db, admin, request())).shiftId, adminShift.id);
    });
    await retire(adminShift.id);
    const active = await newShift();
    await t.test("missing, inactive, unavailable and overflow reject atomically", async () => {
      const start = await counts();
      await assert.rejects(createOrder(db, cashier, { ...request(), items: [{ productId: randomUUID(), quantity: 1 }] }), { code: "PRODUCT_NOT_FOUND" });
      for (const field of ["active", "available"] as const) {
        await db.product.update({ where: { id: product.id }, data: { [field]: false } });
        await assert.rejects(createOrder(db, cashier, request()), { code: "PRODUCT_UNAVAILABLE" });
        await db.product.update({ where: { id: product.id }, data: { [field]: true } });
      }
      await db.product.update({ where: { id: product.id }, data: { price: 2147483647 } });
      await assert.rejects(createOrder(db, cashier, request()), { code: "MONEY_OVERFLOW" });
      await assert.rejects(createOrder(db, cashier, { ...request(), items: [{ productId: product.id, quantity: 1 }, { productId: second.id, quantity: 1 }] }), { code: "MONEY_OVERFLOW" });
      assert.deepEqual(await counts(), start);
      await db.product.update({ where: { id: product.id }, data: { price: product.price } });
    });
    await t.test("real nested item constraint failure rolls back order", async () => {
      const start = await counts();
      const broken = intercept("order", "create", async (tx, args) => {
        const options = args as Prisma.OrderCreateArgs;
        const data = options.data as Prisma.OrderUncheckedCreateInput;
        return tx.order.create({ ...options, data: { ...data, items: { create: [{ productId: product.id, productNameSnapshot: product.name, unitPriceSnapshot: 1, quantity: 0, lineTotal: 0 }] } } });
      });
      await assert.rejects(createOrder(broken, cashier, request()), { code: "CREATE_FAILED" });
      assert.deepEqual(await counts(), start);
    });
    await t.test("real audit foreign key failure rolls back order and items", async () => {
      const start = await counts();
      let reached = false;
      const broken = intercept("auditLog", "create", async (tx, args) => {
        const options = args as Prisma.AuditLogCreateArgs;
        const data = options.data as Prisma.AuditLogUncheckedCreateInput;
        assert.equal(await tx.orderItem.count({ where: { orderId: data.entityId } }), 2);
        reached = true;
        return tx.auditLog.create({ ...options, data: { ...data, actorId: randomUUID() } });
      });
      await assert.rejects(createOrder(broken, cashier, request()), { code: "CREATE_FAILED" });
      assert.equal(reached, true);
      assert.deepEqual(await counts(), start);
    });
    await t.test("simultaneous same-key requests both miss preliminary lookup and produce one order/audit", async () => {
      const input = request();
      const bothRead = gate();
      let reads = 0;
      const racing = new Proxy(db, { get(target, key) {
        if (key !== "order") return Reflect.get(target, key);
        return new Proxy(db.order, { get(delegate, method) {
          if (method !== "findUnique") return Reflect.get(delegate, method);
          return async (args: Prisma.OrderFindUniqueArgs) => {
            const found = await delegate.findUnique(args);
            assert.equal(found, null);
            if (++reads === 2) bothRead.signal();
            await bothRead.promise;
            return found;
          };
        } });
      } });
      const results = await Promise.all([createOrder(racing, cashier, input), createOrder(racing, cashier, input)]);
      assert.equal(results[0].id, results[1].id);
      assert.equal(results.filter((result) => result.replayed).length, 1);
      assert.equal(await db.order.count({ where: { createIdempotencyKey: input.createIdempotencyKey } }), 1);
      assert.equal(await db.auditLog.count({ where: { entityId: results[0].id } }), 1);
    });
    await t.test("real unique violation recovers outside aborted transaction with no duplicate audit", async () => {
      const input = request();
      const original = await createOrder(db, cashier, input);
      const start = await counts();
      // Force stale/missed lookups to exercise the final constraint defense itself.
      // All writes and the unique violation still execute in real PostgreSQL.
      const missedRecheck = intercept("order", "findUnique", async () => null);
      let lookups = 0;
      const stale = new Proxy(missedRecheck, { get(target, key) {
        if (key !== "order") return Reflect.get(target, key);
        return new Proxy(db.order, { get(delegate, method) {
          if (method !== "findUnique") return Reflect.get(delegate, method);
          return (args: Prisma.OrderFindUniqueArgs) => ++lookups === 1 ? Promise.resolve(null) : delegate.findUnique(args);
        } });
      } });
      assert.deepEqual(await createOrder(stale, cashier, input), { ...original, replayed: true });
      assert.equal(lookups, 2, "Recovery lookup occurs after the database rolls back the failed transaction");
      assert.deepEqual(await counts(), start);
      const next = await createOrder(db, cashier, request());
      assert.ok(BigInt(next.orderNumber.slice(3)) > BigInt(original.orderNumber.slice(3)) + BigInt(1), "Failed insert leaves a tolerated sequence gap");
    });
    await retire(active.id);
    await t.test("create wins Shift lock: committed UNPAID blocks waiting close", async () => {
      const shift = await newShift();
      const ready = gate(); const release = gate();
      const paused = intercept("order", "create", async (_tx, _args, run) => { ready.signal(); await release.promise; return run(); });
      const writing = createOrder(paused, cashier, request());
      const observed = writing.then(() => null, (error: unknown) => error);
      let closing: ReturnType<typeof closeShift> | undefined;
      try {
        await Promise.race([ready.promise, writing]);
        await assert.rejects(db.$queryRaw`SELECT id FROM "Shift" WHERE id = ${shift.id}::uuid FOR UPDATE NOWAIT`, /could not obtain lock/);
        closing = closeShift(db, cashier, { shiftId: shift.id, countedCash: 0 });
        const outcome = assert.rejects(closing, { code: "UNRESOLVED_TRANSACTIONS" });
        release.signal();
        await writing; await outcome;
        assert.equal((await db.shift.findUniqueOrThrow({ where: { id: shift.id } })).status, "OPEN");
      } finally { release.signal(); await observed; await closing?.catch(() => undefined); }
      await retire(shift.id);
    });
    await t.test("close wins Shift lock: waiting create rejects CLOSED shift without writes", async () => {
      const shift = await newShift();
      const ready = gate(); const release = gate(); const discovered = gate();
      const pausedClose = intercept("shift", "update", async (_tx, _args, run) => { ready.signal(); await release.promise; return run(); });
      const observedCreate = intercept("shift", "findFirst", async (_tx, _args, run) => { const value = await run(); discovered.signal(); return value; });
      const closing = closeShift(pausedClose, cashier, { shiftId: shift.id, countedCash: 0 });
      const observed = closing.then(() => null, (error: unknown) => error);
      let writing: ReturnType<typeof createOrder> | undefined;
      try {
        await Promise.race([ready.promise, closing]);
        await assert.rejects(db.$queryRaw`SELECT id FROM "Shift" WHERE id = ${shift.id}::uuid FOR UPDATE NOWAIT`, /could not obtain lock/);
        writing = createOrder(observedCreate, cashier, request());
        const outcome = assert.rejects(writing, { code: "NO_ACTIVE_SHIFT" });
        await Promise.race([discovered.promise, writing]);
        release.signal();
        await closing; await outcome;
        assert.equal(await db.order.count({ where: { shiftId: shift.id } }), 0);
      } finally { release.signal(); await observed; await writing?.catch(() => undefined); }
    });
  } finally {
    // Only generated fixture identities; never delete or update preexisting records.
    await db.$transaction(async (tx) => {
      await tx.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
      await tx.orderItem.deleteMany({ where: { order: { cashierId: { in: userIds } } } });
      await tx.order.deleteMany({ where: { cashierId: { in: userIds } } });
      await tx.shift.deleteMany({ where: { id: { in: shiftIds } } });
      await tx.product.deleteMany({ where: { categoryId } });
      await tx.category.deleteMany({ where: { id: categoryId } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
    });
    try {
      assert.deepEqual(await baseline(), before, "All development rows restored exactly");
      t.diagnostic(`Development rows restored; order_number_seq last_value=${await sequence()} (never reset)`);
    } finally { await db.$disconnect(); }
  }
});
