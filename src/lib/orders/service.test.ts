import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { fingerprintCreateRequest, normalizeCreateRequest } from "./domain";
import { createOrder } from "./service";

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
