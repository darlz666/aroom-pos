import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { test, type TestContext } from "node:test";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { normalizePaymentRequest, paymentFingerprint } from "./domain";

async function loadService(t: TestContext) {
  // Plain Node does not apply Next's server-only module alias.
  const require = createRequire(import.meta.url);
  const serverOnlyPath = require.resolve("server-only");
  const original = require.cache[serverOnlyPath];
  require.cache[serverOnlyPath] = { exports: {} } as NodeModule;
  t.after(() => {
    if (original) require.cache[serverOnlyPath] = original;
    else delete require.cache[serverOnlyPath];
  });
  return import("./service");
}

const actor = { id: randomUUID(), role: "CASHIER" as const };
const input = { orderId: randomUUID(), expectedRevision: 1, attemptIdentifier: randomUUID(), method: "CASH", cashReceived: 30000 };
const payment = { id: randomUUID(), orderId: input.orderId, method: "CASH", status: "SUCCEEDED", amount: 22000,
  cashReceived: 30000, changeAmount: 8000, edcReference: null, succeededAt: new Date(), requestFingerprint: paymentFingerprint(actor.id, normalizePaymentRequest(input)) };
test("committed retry exposes safe fields without requiring a shift or transaction", async (t) => {
  const { recordManualPayment } = await loadService(t);
  const db = { payment: { findUnique: async () => payment } } as unknown as PrismaClient;
  const result = await recordManualPayment(db, actor, input);
  assert.equal(result.replayed, true);
  assert.deepEqual(Object.keys(result).sort(), ["id", "orderId", "method", "status", "amount", "cashReceived", "changeAmount", "edcReference", "succeededAt", "replayed"].sort());
  await assert.rejects(recordManualPayment(db, actor, { ...input, method: "BCA_EDC", cashReceived: undefined }), { code: "INVALID_INPUT" });
  await assert.rejects(recordManualPayment(db, { ...actor, role: "INVALID" as "CASHIER" }, input), { code: "FORBIDDEN" });
});
test("post-lock retry recovery works after shift closes; unique conflict reads only after rollback", async (t) => {
  const { recordManualPayment } = await loadService(t);
  const db = { payment: { findUnique: async () => null }, $transaction: async (fn: (tx: unknown) => unknown) => fn({
    order: { findUnique: async () => ({ shiftId: randomUUID() }) },
    $queryRaw: async () => [{ status: "CLOSED" }], payment: { findUnique: async () => payment },
  }) } as unknown as PrismaClient;
  assert.equal((await recordManualPayment(db, actor, input)).replayed, true);
  let rolledBack = false; let reads = 0;
  const raced = { payment: { findUnique: async () => { if (++reads === 1) return null; assert.ok(rolledBack); return payment; } },
    $transaction: async () => { rolledBack = true; throw new Prisma.PrismaClientKnownRequestError("private", { code: "P2002", clientVersion: "test" }); },
  } as unknown as PrismaClient;
  assert.equal((await recordManualPayment(raced, actor, input)).replayed, true);
});
test("uncertain commit never retries automatically and same key recovers committed result", async (t) => {
  const { recordManualPayment } = await loadService(t);
  let committed = false; let attempts = 0;
  const db = { payment: { findUnique: async () => committed ? payment : null },
    $transaction: async () => { attempts++; committed = true; throw new Error("lost commit response"); },
  } as unknown as PrismaClient;
  await assert.rejects(recordManualPayment(db, actor, input), { code: "PAYMENT_FAILED" });
  assert.equal((await recordManualPayment(db, actor, input)).replayed, true);
  assert.equal(attempts, 1);
});
