import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { fingerprintCreateRequest, normalizeCreateRequest } from "./domain";
import { cancelOrder, createOrder, editOrder } from "./service";
import { defaultCup, type CupCustomization } from "./customizations";

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

test("metadata snapshots replay safely and changed customer or individual cup intent cannot reuse a create key", async () => {
  const cups = [{ ...defaultCup(), sugar: "NO_SUGAR" as const }];
  const input = { ...request, customerName: "Dina", items: [{ ...request.items[0], cups, notes: "Takeaway" }] };
  const snapshot = { ...stored, customerName: "Dina", createRequestFingerprint: fingerprintCreateRequest(normalizeCreateRequest(input)),
    items: stored.items.map(item => ({ ...item, notes: "Takeaway", cupCustomizations: cups })) };
  const db = { order: { findUnique: async () => snapshot } } as unknown as PrismaClient;
  const result = await createOrder(db, actor, input);
  assert.equal(result.customerName, "Dina"); assert.deepEqual(result.items[0].cups, cups); assert.equal(result.items[0].notes, "Takeaway");
  for (const changed of [{ ...input, customerName: "Other" }, { ...input, items: [{ ...input.items[0], cups: [defaultCup()] }] }]) {
    await assert.rejects(createOrder(db, actor, changed), { code: "IDEMPOTENCY_CONFLICT" });
  }
});

test("customization and customer edits inherit paid, pending-payment, owner and revision protections", async () => {
  for (const operation of [{ type: "SET_CUSTOMER", customerName: "Dina" },
    { type: "SET_ITEM_DETAILS", orderItemId: stored.items[0].id, cups: [defaultCup()] }]) {
    for (const [options, code] of [[{ status: "PAID" }, "ORDER_NOT_EDITABLE"], [{ status: "CANCELLED" }, "ORDER_NOT_EDITABLE"],
      [{ payments: ["PENDING"] }, "PAYMENT_BLOCKED"], [{ payments: ["SUCCEEDED"] }, "PAYMENT_BLOCKED"],
      [{ revision: 2 }, "REVISION_CONFLICT"], [{ shiftOwner: randomUUID() }, "FORBIDDEN"]] as const) {
      const { db, events } = mutationFixture(options);
      await assert.rejects(editOrder(db, actor, { orderId: stored.id, expectedRevision: 1, operation }), { code });
      assert.ok(!events.includes("audit") && !events.some(event => event.includes("write")));
    }
  }
});

test("cup metadata edits retain fixed money, increment once, audit once, and avoid product/stock reads", async () => {
  let snapshot = { ...stored, customerName: "Dina" as string | null,
    items: stored.items.map(item => ({ ...item, notes: null as string | null, cupCustomizations: [defaultCup()] as CupCustomization[] | null })) };
  const audits: unknown[] = []; let itemWrites = 0; let orderWrites = 0;
  const tx = {
    $queryRaw: async (sql: TemplateStringsArray) => sql.join("").includes('"Shift"')
      ? [{ id: stored.shiftId, cashierId: actor.id, status: "OPEN" }]
      : sql.join("").includes('"Order"') ? [{ id: stored.id }] : [],
    order: {
      findUnique: async (query: { select: Record<string, unknown> }) => Object.keys(query.select).length === 1 ? { shiftId: stored.shiftId } : structuredClone(snapshot),
      update: async (query: { data: { customerName?: string | null } }) => {
        orderWrites++; snapshot = { ...snapshot, revision: snapshot.revision + 1,
          ...(Object.hasOwn(query.data, "customerName") ? { customerName: query.data.customerName ?? null } : {}) };
        return structuredClone(snapshot);
      },
    },
    orderItem: {
      findMany: async () => snapshot.items.map(item => ({ lineTotal: item.lineTotal })),
      update: async (query: { data: { notes: string | null; cupCustomizations: unknown } }) => {
        itemWrites++;
        snapshot.items[0].notes = query.data.notes;
        snapshot.items[0].cupCustomizations = query.data.cupCustomizations === Prisma.DbNull ? null : query.data.cupCustomizations as CupCustomization[];
      },
    },
    auditLog: { create: async (query: unknown) => { audits.push(query); } },
  };
  const db = { $transaction: async (fn: (value: unknown) => unknown) => fn(tx) } as unknown as PrismaClient;
  const execute = (operation: unknown) => editOrder(db, actor, { orderId: stored.id, expectedRevision: snapshot.revision, operation });
  const cups = [{ ...defaultCup(), cup: "LARGE" as const, notes: "No foam" }];
  const result = await execute({ type: "SET_ITEM_DETAILS", orderItemId: stored.items[0].id, cups, notes: "Takeaway" });
  assert.equal(result.total, 42); assert.equal(result.items[0].unitPrice, 42); assert.equal(result.items[0].quantity, 1);
  assert.deepEqual(result.items[0].cups, cups); assert.equal(result.items[0].notes, "Takeaway");
  assert.equal(result.revision, 2); assert.equal(itemWrites, 1); assert.equal(orderWrites, 1); assert.equal(audits.length, 1);
  // PostgreSQL JSONB changes object-key ordering; a semantically equal request is still a no-op.
  snapshot.items[0].cupCustomizations = [{ notes: "No foam", cup: "LARGE", ice: "NORMAL", sugar: "NORMAL" }];
  assert.equal((await execute({ type: "SET_ITEM_DETAILS", orderItemId: stored.items[0].id, cups, notes: "Takeaway" })).revision, 2);
  assert.equal(audits.length, 1);
  await assert.rejects(execute({ type: "SET_ITEM_DETAILS", orderItemId: stored.items[0].id, cups: [defaultCup(), defaultCup()] }), { code: "INVALID_INPUT" });
  assert.equal(audits.length, 1);
  const cleared = await execute({ type: "SET_ITEM_DETAILS", orderItemId: stored.items[0].id });
  assert.equal(cleared.items[0].cups, undefined); assert.equal(cleared.items[0].notes, undefined); assert.equal(cleared.total, 42);
  const customer = await execute({ type: "SET_CUSTOMER", customerName: "Other" });
  assert.equal(customer.customerName, "Other"); assert.equal(customer.total, 42);
  assert.equal((await execute({ type: "SET_CUSTOMER" })).customerName, undefined);
  assert.equal(itemWrites, 2); assert.equal(orderWrites, 4); assert.equal(audits.length, 4);
});
