import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { fingerprintCreateRequest, normalizeCreateRequest } from "./domain";
import { cancelOrder, createOrder, editOrder } from "./service";

const actor = { id: randomUUID(), role: "CASHIER" as const };
const request = { createIdempotencyKey: randomUUID(), orderType: "DINE_IN", items: [{ productId: randomUUID(), quantity: 1 }] };
const stored = { id: randomUUID(), cashierId: actor.id, createRequestFingerprint: fingerprintCreateRequest(normalizeCreateRequest(request)),
  orderNumber: "AR-000042", status: "UNPAID", revision: 1, shiftId: randomUUID(), orderType: "DINE_IN", total: 42,
  createdAt: new Date(), items: [{ id: randomUUID(), productId: request.items[0].productId, productNameSnapshot: "Original", unitPriceSnapshot: 42, quantity: 1, lineTotal: 42 }] };
test("replay needs no transaction, shift, products or sequence and returns only safe fields", async () => {
  const db = { order: { findUnique: async () => stored } } as unknown as PrismaClient;
  const result = await createOrder(db, actor, request);
  assert.equal(result.replayed, true);
  assert.equal(result.items[0].productName, "Original");
  assert.deepEqual(Object.keys(result).sort(), ["id", "orderNumber", "status", "revision", "shiftId", "cashierId", "orderType", "total", "createdAt", "items", "replayed"].sort());
  for (const changed of [{ ...request, orderType: "TAKEAWAY" }, { ...request, items: [{ ...request.items[0], quantity: 2 }] }]) {
    await assert.rejects(createOrder(db, actor, changed), { code: "IDEMPOTENCY_CONFLICT" });
  }
  await assert.rejects(createOrder(db, { ...actor, id: randomUUID() }, request), { code: "IDEMPOTENCY_CONFLICT", message: "IDEMPOTENCY_CONFLICT" });
});
test("post-lock recheck recovers winner even when locked shift has closed", async () => {
  const events: string[] = [];
  const tx = {
    shift: { findFirst: async () => { events.push("discover"); return { id: stored.shiftId }; } },
    $queryRaw: async () => { events.push("lock"); return [{ id: stored.shiftId, status: "CLOSED" }]; },
    order: { findUnique: async () => { events.push("recheck"); return stored; } },
  };
  const db = { order: { findUnique: async () => null }, $transaction: async (fn: (value: unknown) => unknown) => fn(tx) } as unknown as PrismaClient;
  assert.equal((await createOrder(db, actor, request)).replayed, true);
  assert.deepEqual(events, ["discover", "lock", "recheck"]);
});
test("unique failure recovers only after transaction rollback, otherwise returns controlled failure", async () => {
  for (const winner of [stored, { ...stored, cashierId: randomUUID() }, null]) {
    let rolledBack = false;
    let reads = 0;
    const db = {
      order: { findUnique: async () => { if (++reads === 1) return null; assert.equal(rolledBack, true); return winner; } },
      $transaction: async () => { rolledBack = true; throw new Prisma.PrismaClientKnownRequestError("private database details", { code: "P2002", clientVersion: "test" }); },
    } as unknown as PrismaClient;
    if (winner === stored) assert.equal((await createOrder(db, actor, request)).replayed, true);
    else await assert.rejects(createOrder(db, actor, request), { code: winner ? "IDEMPOTENCY_CONFLICT" : "CREATE_FAILED" });
  }
});
test("connectivity and unexpected provider errors never expose raw details", async () => {
  const db = { order: { findUnique: async () => { throw new Error("secret connection details"); } } } as unknown as PrismaClient;
  await assert.rejects(createOrder(db, actor, request), { code: "CREATE_FAILED", message: "CREATE_FAILED" });
  await assert.rejects(createOrder(db, { ...actor, role: "INVALID" as "CASHIER" }, request), { code: "FORBIDDEN" });
});

function mutationFixture(options: { shiftStatus?: string; shiftOwner?: string; status?: string; revision?: number; payments?: readonly string[]; moved?: boolean; missing?: boolean; missingProduct?: boolean; eligible?: boolean } = {}) {
  const events: string[] = [];
  const order = structuredClone(stored);
  order.status = options.status ?? "UNPAID";
  order.revision = options.revision ?? 1;
  const tx = {
    $queryRaw: async (sql: TemplateStringsArray) => {
      const query = sql.join("?");
      if (query.includes('"Shift"')) { events.push("Shift"); return [{ id: stored.shiftId, cashierId: options.shiftOwner ?? actor.id, status: options.shiftStatus ?? "OPEN" }]; }
      if (query.includes('"Order"')) { events.push("Order"); return [{ id: order.id }]; }
      events.push("Payment"); return (options.payments ?? []).map((status) => ({ status }));
    },
    order: {
      findUnique: async (args: { select: Record<string, unknown> }) => {
        if (options.missing) return null;
        if (Object.keys(args.select).length === 1) { events.push("discover persisted shift"); return { shiftId: stored.shiftId }; }
        events.push("reread"); return { ...order, shiftId: options.moved ? randomUUID() : stored.shiftId };
      },
      update: async () => { events.push("write"); return { ...order, revision: order.revision + 1 }; },
    },
    product: { findUnique: async () => { events.push("product"); return options.missingProduct ? null : { active: options.eligible ?? true, available: options.eligible ?? true }; } },
    orderItem: { update: async () => { events.push("item write"); }, findMany: async () => [{ lineTotal: 84 }] },
    auditLog: { create: async () => { events.push("audit"); } },
  };
  const db = { $transaction: async (fn: (value: unknown) => unknown) => fn(tx) } as unknown as PrismaClient;
  return { db, events };
}
const edit = { orderId: stored.id, expectedRevision: 1, operation: { type: "SET_QUANTITY", orderItemId: stored.items[0].id, quantity: 2 } };
const cancel = { orderId: stored.id, expectedRevision: 1 };
test("mutation locks persisted Shift then Order then Payment; no-op does not write or audit", async () => {
  const { db, events } = mutationFixture();
  const state = await editOrder(db, actor, edit);
  assert.equal(state.revision, 2);
  assert.deepEqual(events, ["discover persisted shift", "Shift", "Order", "reread", "Payment", "product", "item write", "write", "audit"]);
  assert.deepEqual(Object.keys(state).sort(), ["id", "orderNumber", "status", "revision", "shiftId", "cashierId", "orderType", "total", "createdAt", "items"].sort());
  const noop = mutationFixture();
  assert.equal((await editOrder(noop.db, actor, { ...edit, operation: { ...edit.operation, quantity: 1 } })).revision, 1);
  assert.deepEqual(noop.events, ["discover persisted shift", "Shift", "Order", "reread", "Payment"]);
});
test("both mutations reject protected states before any write or audit", async () => {
  for (const [options, code] of [
    [{ missing: true }, "ORDER_NOT_FOUND"], [{ moved: true }, "FORBIDDEN"],
    [{ shiftStatus: "CLOSED" }, "NO_ACTIVE_SHIFT"], [{ shiftOwner: randomUUID() }, "FORBIDDEN"],
    [{ status: "PAID" }, "ORDER_NOT_EDITABLE"], [{ status: "CANCELLED" }, "ORDER_NOT_EDITABLE"],
    [{ revision: 2 }, "REVISION_CONFLICT"], [{ payments: ["PENDING"] }, "PAYMENT_BLOCKED"], [{ payments: ["SUCCEEDED"] }, "PAYMENT_BLOCKED"],
  ] as const) {
    for (const mutation of [editOrder, cancelOrder]) {
      const { db, events } = mutationFixture(options);
      await assert.rejects(mutation(db, actor, mutation === editOrder ? edit : cancel), { code });
      assert.ok(!events.some((event) => event.includes("write") || event === "audit"));
    }
  }
});
test("missing and ineligible products block quantity increases without writes", async () => {
  for (const [options, code] of [[{ missingProduct: true }, "PRODUCT_NOT_FOUND"], [{ eligible: false }, "PRODUCT_UNAVAILABLE"]] as const) {
    const { db, events } = mutationFixture(options);
    await assert.rejects(editOrder(db, actor, edit), { code });
    assert.ok(!events.includes("item write"));
  }
});
test("edit/cancel connectivity failures expose only controlled errors and never retry", async () => {
  for (const mutation of [editOrder, cancelOrder]) {
    let attempts = 0;
    const db = { $transaction: async () => { attempts++; throw new Error("private database credentials"); } } as unknown as PrismaClient;
    const code = mutation === editOrder ? "UPDATE_FAILED" : "CANCEL_FAILED";
    await assert.rejects(mutation(db, actor, mutation === editOrder ? edit : cancel), { code, message: code });
    assert.equal(attempts, 1);
  }
});

// Minimal read boundary: query contracts and DTOs, without database writes.
test("active reads enforce operable OPEN shift and authenticated actor semantics", async () => {
  const { listActiveUnpaidOrders, getActiveUnpaidOrder } = await import("./service");
  for (const read of [listActiveUnpaidOrders, (db: PrismaClient, actor: { id: string; role: "CASHIER" | "ADMIN" }) => getActiveUnpaidOrder(db, actor, stored.id)]) {
    for (const [reader, shift, code] of [
      [{ ...actor, id: "" }, null, "FORBIDDEN"],
      [{ ...actor, role: "INVALID" }, null, "FORBIDDEN"],
      [actor, null, "NO_ACTIVE_SHIFT"],
      [actor, { id: stored.shiftId, cashierId: actor.id, status: "CLOSED" }, "NO_ACTIVE_SHIFT"],
      [actor, { id: stored.shiftId, cashierId: randomUUID(), status: "OPEN" }, "FORBIDDEN"],
    ] as const) {
      let orderReads = 0;
      const db = { shift: { findFirst: async () => shift }, order: { findMany: async () => { orderReads++; }, findFirst: async () => { orderReads++; } } } as unknown as PrismaClient;
      await assert.rejects(read(db, reader as typeof actor), { code }); assert.equal(orderReads, 0);
    }
  }
});

test("list filters current shift UNPAID newest first; detail filters hidden existence and returns authoritative safe DTO", async () => {
  const { listActiveUnpaidOrders, getActiveUnpaidOrder } = await import("./service");
  for (const role of ["CASHIER", "ADMIN"] as const) {
    const shift = { id: stored.shiftId, cashierId: actor.id, status: "OPEN" };
    const rows = [
      { ...stored, createdAt: new Date("2026-09-15T02:00:00Z"), revision: 9 },
      { ...stored, id: randomUUID(), createdAt: new Date("2026-09-15T01:00:00Z") },
      { ...stored, id: randomUUID(), status: "PAID" },
      { ...stored, id: randomUUID(), status: "CANCELLED" },
      { ...stored, id: randomUUID(), shiftId: randomUUID() },
    ];
    const reader = { id: role === "ADMIN" ? randomUUID() : actor.id, role };
    const db = {
      shift: { findFirst: async (query: unknown) => { assert.deepEqual(query, { where: { status: "OPEN" } }); return shift; } },
      order: {
        findMany: async (query: { where: unknown; orderBy: unknown }) => {
          assert.deepEqual(query.where, { shiftId: shift.id, status: "UNPAID" });
          assert.deepEqual(query.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
          return rows.filter(row => row.shiftId === shift.id && row.status === "UNPAID");
        },
        findFirst: async (query: { where: { id: string; shiftId: string; status: string } }) => {
          assert.deepEqual(query.where, { id: query.where.id, shiftId: shift.id, status: "UNPAID" });
          return rows.find(row => row.id === query.where.id && row.shiftId === query.where.shiftId && row.status === query.where.status) ?? null;
        },
      },
    } as unknown as PrismaClient;
    const list = await listActiveUnpaidOrders(db, reader);
    assert.deepEqual(list.map(row => row.id), rows.slice(0, 2).map(row => row.id));
    const detail = await getActiveUnpaidOrder(db, reader, stored.id.toUpperCase());
    assert.deepEqual(detail, list[0]); assert.equal(detail.revision, 9); assert.equal(detail.items[0].unitPrice, 42);
    assert.deepEqual(Object.keys(detail).sort(), ["id", "orderNumber", "status", "revision", "shiftId", "cashierId", "orderType", "total", "createdAt", "items"].sort());
    assert.deepEqual(Object.keys(detail.items[0]).sort(), ["id", "productId", "productName", "unitPrice", "quantity", "lineTotal"].sort());
    assert.doesNotMatch(JSON.stringify(list), /Fingerprint|Idempotency|payments|password|Snapshot/);
    for (const row of rows.slice(2)) await assert.rejects(getActiveUnpaidOrder(db, reader, row.id), { code: "ORDER_NOT_FOUND" });
    await assert.rejects(getActiveUnpaidOrder(db, reader, randomUUID()), { code: "ORDER_NOT_FOUND" });
    for (const id of ["bad", "", "' OR 1=1", { shiftId: shift.id }]) await assert.rejects(getActiveUnpaidOrder(db, reader, id as string), { code: "INVALID_INPUT" });
  }
});
