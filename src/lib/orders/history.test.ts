import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { PrismaClient } from "../../generated/prisma/client";

const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = { id: id(1), role: "CASHIER" as const };
const admin = { id: id(2), role: "ADMIN" as const };
const other = { id: id(3), role: "CASHIER" as const };
const date = new Date("2026-09-17T03:00:00.000Z");
function row(n: number, status = "PAID", cashierId = owner.id, creatorId = owner.id) {
  return {
    id: id(n), orderNumber: `AR-${String(n).padStart(6, "0")}`, status, orderType: "DINE_IN",
    total: 44000, createdAt: date, paidAt: status === "PAID" ? date : null,
    cancelledAt: status === "CANCELLED" ? date : null,
    createIdempotencyKey: "secret", createRequestFingerprint: "secret", revision: 7,
    cashier: { id: creatorId, name: "Order creator", passwordHash: "secret", loginIdentifier: "secret" },
    shift: { id: id(100), cashierId, status: "CLOSED", openedAt: date, closedAt: date as Date | null,
      openingCash: 100000, countedCash: 144000, variance: 0,
      cashier: { id: cashierId, name: "Shift owner", passwordHash: "secret" } },
    items: [{ id: id(101), productId: id(102), productNameSnapshot: "Saved coffee", unitPriceSnapshot: 22000,
      quantity: 2, notes: "Less sweet", lineTotal: 44000, product: { name: "Changed menu", price: 99000 } }],
    payments: [{ id: id(103), method: "CASH", status: "SUCCEEDED", amount: 44000,
      cashReceived: 50000, changeAmount: 6000, edcReference: null, createdAt: date, updatedAt: date, succeededAt: date,
      attemptIdentifier: "secret", requestFingerprint: "secret", midtransReference: "secret", notifications: ["secret"] }],
  };
}
type Row = ReturnType<typeof row>;
function fixture(rows: Row[]) {
  const queries: unknown[] = [];
  const db = { order: {
    findMany: async (query: { where: { shift: { cashierId?: string }; orderNumber?: string;
      OR?: [{ createdAt: { lt: Date } }, { createdAt: Date; id: { lt: string } }] };
      orderBy: unknown; take: number; select: unknown }) => {
      queries.push(query);
      assert.deepEqual(query.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
      assert.ok(query.take >= 2 && query.take <= 101);
      assert.doesNotMatch(JSON.stringify(query.select), /Fingerprint|Idempotency|password|loginIdentifier|payments|items/);
      const { shift, orderNumber, OR } = query.where;
      return rows.filter(r => (!shift.cashierId || r.shift.cashierId === shift.cashierId) &&
        (!orderNumber || r.orderNumber === orderNumber) && (!OR || r.createdAt < OR[0].createdAt.lt ||
          (r.createdAt.getTime() === OR[1].createdAt.getTime() && r.id < OR[1].id.lt)))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)).slice(0, query.take);
    },
    findUnique: async (query: { where: { id: string }; select: unknown }) => {
      queries.push(query);
      assert.doesNotMatch(JSON.stringify(query.select), /Fingerprint|Idempotency|password|loginIdentifier|attemptIdentifier|midtransReference|notifications|"product"/);
      return rows.find(r => r.id === query.where.id) ?? null;
    },
  }, shift: { findFirst: async () => { throw new Error("History must not discover the active shift"); } } } as unknown as PrismaClient;
  return { db, rows, queries };
}

test("historical order reads", async t => {
  const require = createRequire(import.meta.url);
  const path = require.resolve("server-only");
  const original = require.cache[path];
  require.cache[path] = { exports: {} } as NodeModule;
  t.after(() => { if (original) require.cache[path] = original; else delete require.cache[path]; });
  const { listOrderHistory, getHistoricalOrder } = await import("./history");

  await t.test("no open shift, closed original shift and another open shift do not restrict historical reads", async () => {
    for (const active of [null, { cashierId: owner.id, status: "OPEN" }, { cashierId: other.id, status: "OPEN" }]) {
      const f = fixture([row(10)]);
      // Any attempt to discover register state fails this test.
      f.db.shift.findFirst = (async () => { assert.fail(`Unexpected active shift lookup: ${JSON.stringify(active)}`); }) as unknown as typeof f.db.shift.findFirst;
      assert.equal((await listOrderHistory(f.db, owner)).orders.length, 1);
      assert.equal((await getHistoricalOrder(f.db, owner, id(10))).shift.status, "CLOSED");
    }
  });
  await t.test("all statuses appear, Admin sees all shifts, cashier visibility follows shift owner including admin assistance", async () => {
    const f = fixture([row(10, "UNPAID"), row(11, "PAID", owner.id, admin.id), row(12, "CANCELLED"), row(13, "PAID", other.id)]);
    const own = await listOrderHistory(f.db, owner);
    assert.deepEqual(own.orders.map(r => r.status), ["CANCELLED", "PAID", "UNPAID"]);
    assert.equal(own.orders[1].cashier.id, admin.id);
    assert.equal(own.orders[1].shift.cashier.id, owner.id);
    assert.equal((await listOrderHistory(f.db, admin)).orders.length, 4);
    for (const r of f.rows) assert.equal((await getHistoricalOrder(f.db, admin, r.id)).id, r.id);
    assert.equal((await getHistoricalOrder(f.db, owner, id(11))).cashier.id, admin.id);
    await assert.rejects(getHistoricalOrder(f.db, owner, id(13)), { code: "FORBIDDEN" });
    await assert.rejects(getHistoricalOrder(f.db, other, id(11)), { code: "FORBIDDEN" });
    await assert.rejects(getHistoricalOrder(f.db, owner, id(999)), { code: "ORDER_NOT_FOUND" });
  });
  await t.test("detail preserves safe snapshots, timestamps, separate statuses and payment fields", async () => {
    const f = fixture([row(10)]);
    const result = await getHistoricalOrder(f.db, owner, id(10).toUpperCase());
    assert.deepEqual(Object.keys(result).sort(), ["id", "orderNumber", "status", "orderType", "total", "createdAt", "paidAt", "cancelledAt", "cashier", "shift", "items", "payments"].sort());
    assert.deepEqual(result.items, [{ id: id(101), productId: id(102), productName: "Saved coffee", unitPrice: 22000, quantity: 2, notes: "Less sweet", lineTotal: 44000 }]);
    assert.deepEqual(result.payments, [{ id: id(103), method: "CASH", status: "SUCCEEDED", amount: 44000, cashReceived: 50000, changeAmount: 6000, edcReference: null,
      createdAt: date.toISOString(), updatedAt: date.toISOString(), succeededAt: date.toISOString() }]);
    assert.equal(result.createdAt, date.toISOString());
    assert.equal(result.paidAt, date.toISOString());
    assert.equal(result.cancelledAt, null);
    assert.deepEqual(result.cashier, { id: owner.id, name: "Order creator" });
    assert.deepEqual(result.shift, { id: id(100), status: "CLOSED", openedAt: date.toISOString(), closedAt: date.toISOString(), cashier: { id: owner.id, name: "Shift owner" } });
    assert.doesNotMatch(JSON.stringify([result, await listOrderHistory(f.db, owner)]), /secret|Fingerprint|Idempotency|password|loginIdentifier|attemptIdentifier|midtransReference|notifications/);
    f.rows[0].items[0].product = { name: "Another menu name", price: 1 };
    assert.deepEqual(await getHistoricalOrder(f.db, owner, id(10)), result);
    f.rows[0].status = "UNPAID"; f.rows[0].paidAt = null; f.rows[0].shift.status = "OPEN"; f.rows[0].shift.closedAt = null;
    f.rows[0].payments = [];
    const unpaid = await getHistoricalOrder(f.db, owner, id(10));
    assert.equal(unpaid.paidAt, null); assert.equal(unpaid.shift.closedAt, null); assert.deepEqual(unpaid.payments, []);
  });
  await t.test("order-number lookup is exact, normalized, authorized and returns empty when absent", async () => {
    const f = fixture([row(10), row(11, "PAID", other.id)]);
    assert.deepEqual((await listOrderHistory(f.db, owner, { orderNumber: " ar-000010 " })).orders.map(r => r.id), [id(10)]);
    for (const orderNumber of ["AR-000011", "AR-999999"]) assert.deepEqual(await listOrderHistory(f.db, owner, { orderNumber }), { orders: [], nextCursor: null });
    assert.equal((await listOrderHistory(f.db, admin, { orderNumber: "AR-000011" })).orders.length, 1);
  });
  await t.test("bounded pages use deterministic timestamp/id ordering without duplicates when new orders arrive", async () => {
    const f = fixture(Array.from({ length: 105 }, (_, i) => row(i + 10)));
    f.rows[0].createdAt = new Date("2026-09-18T00:00:00Z"); // Timestamp takes priority over UUID.
    const first = await listOrderHistory(f.db, owner, { limit: 2 });
    assert.deepEqual(first.orders.map(r => r.id), [id(10), id(114)]);
    const expected = f.rows.filter(r => !first.orders.some(o => o.id === r.id)).map(r => r.id).sort().reverse();
    f.rows.push({ ...row(500), createdAt: new Date("2026-09-19T00:00:00Z") });
    const seen: string[] = [];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await listOrderHistory(f.db, owner, { limit: 25, cursor });
      assert.ok(page.orders.length <= 25);
      seen.push(...page.orders.map(r => r.id)); cursor = page.nextCursor;
    }
    assert.deepEqual(seen, expected);
    assert.equal((await listOrderHistory(f.db, owner)).orders.length, 25);
    assert.equal((await listOrderHistory(f.db, owner, { limit: 100 })).orders.length, 100);
    assert.deepEqual(await listOrderHistory(fixture([]).db, owner), { orders: [], nextCursor: null });
  });
  await t.test("invalid pagination, lookup and forged authority are rejected before database reads", async () => {
    const f = fixture([]);
    const cursor = { id: id(10), createdAt: date.toISOString() };
    for (const input of [null, [], "bad", { limit: null }, ...[0, -1, 101, 1.5, NaN, Infinity, "25"].map(limit => ({ limit })),
      ...[null, 42, "", "AR-1", "AR-000010%", "' OR 1=1", "x".repeat(100)].map(orderNumber => ({ orderNumber })),
      ...[null, "bad", {}, { ...cursor, id: "bad" }, { ...cursor, createdAt: "2026-02-30T00:00:00.000Z" },
        { ...cursor, createdAt: "2026-09-17" }, { ...cursor, createdAt: "bad" }, { ...cursor, actorId: other.id }].map(cursor => ({ cursor })),
      ...["actorId", "cashierId", "shiftId", "role", "total", "skip", "status"].map(key => ({ [key]: other.id }))]) {
      await assert.rejects(listOrderHistory(f.db, owner, input), { code: "INVALID_INPUT" });
    }
    for (const value of [null, {}, "", "bad", { orderId: id(10) }]) await assert.rejects(getHistoricalOrder(f.db, owner, value), { code: "INVALID_INPUT" });
    assert.equal(f.queries.length, 0);
  });
  await t.test("invalid actors and database failures expose controlled errors only", async () => {
    const f = fixture([]);
    for (const actor of [{ ...owner, id: "" }, { ...owner, role: "INVALID" as "CASHIER" }]) {
      await assert.rejects(listOrderHistory(f.db, actor), { code: "FORBIDDEN" });
      await assert.rejects(getHistoricalOrder(f.db, actor, id(10)), { code: "FORBIDDEN" });
    }
    assert.equal(f.queries.length, 0);
    const fail = async () => { throw new Error("secret database connection"); };
    const db = { order: { findMany: fail, findUnique: fail } } as unknown as PrismaClient;
    await assert.rejects(listOrderHistory(db, owner), { code: "UPDATE_FAILED", message: "UPDATE_FAILED" });
    await assert.rejects(getHistoricalOrder(db, owner, id(10)), { code: "UPDATE_FAILED", message: "UPDATE_FAILED" });
  });
  await t.test("repeated reads preserve all stored order, payment and shift data", async () => {
    const f = fixture([row(10)]);
    const before = structuredClone(f.rows);
    const first = await listOrderHistory(f.db, owner);
    const detail = await getHistoricalOrder(f.db, owner, id(10));
    assert.deepEqual(await listOrderHistory(f.db, owner), first);
    assert.deepEqual(await getHistoricalOrder(f.db, owner, id(10)), detail);
    assert.deepEqual(f.rows, before);
  });
});
