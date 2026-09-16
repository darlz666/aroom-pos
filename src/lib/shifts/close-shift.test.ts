import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { Prisma, PrismaClient, Shift } from "../../generated/prisma/client";
import type { ShiftActor } from "./domain";

const shiftId = "00000000-0000-4000-8000-000000000001";
const owner: ShiftActor = { id: "owner", role: "CASHIER" };

// Models row-lock waiting and commit/rollback; real PostgreSQL races remain in
// prisma/close-shift.test.ts. No server-only production boundary is weakened.
function fixture(failSettlement = false) {
  let shift = { id: shiftId, cashierId: owner.id, status: "OPEN", openingCash: 100000,
    closedAt: null, expectedCash: null, countedCash: null, variance: null } as Shift;
  const audits: Prisma.AuditLogCreateArgs[] = [];
  const events: string[] = [];
  let lockTail = Promise.resolve();
  const db = { $transaction: async (work: (tx: unknown) => Promise<unknown>, options: unknown) => {
    assert.deepEqual(options, { isolationLevel: "ReadCommitted" });
    let release: (() => void) | undefined;
    let before: Shift | undefined;
    let auditCount = 0;
    const tx = {
      $queryRaw: async (sql: TemplateStringsArray, id: string) => {
        assert.match(sql.join("?"), /WHERE "id" = \?::uuid FOR UPDATE/);
        assert.equal(id, shiftId);
        events.push("waiting");
        const previous = lockTail;
        lockTail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        before = { ...shift };
        auditCount = audits.length;
        events.push("locked");
        return [{ ...shift }];
      },
      order: { findFirst: async () => null },
      payment: {
        findFirst: async () => null,
        aggregate: async (args: unknown) => {
          assert.ok(before, "settlement must run after acquiring the shift lock");
          assert.deepEqual(args, { where: { status: "SUCCEEDED", order: { shiftId, status: "PAID" }, method: "CASH" }, _sum: { amount: true } });
          events.push("settlement");
          if (failSettlement) throw new Error("Connection lost during settlement");
          return { _sum: { amount: 22000 } };
        },
      },
      shift: { update: async ({ data }: Prisma.ShiftUpdateArgs) => {
        events.push("close");
        shift = { ...shift, ...data } as Shift;
        return shift;
      } },
      auditLog: { create: async (args: Prisma.AuditLogCreateArgs) => { audits.push(args); } },
    };
    try { return await work(tx); }
    catch (error) {
      if (before) { shift = before; audits.length = auditCount; }
      throw error;
    } finally { release?.(); }
  } } as unknown as PrismaClient;
  return { db, audits, events, get shift() { return shift; } };
}

test("close shift foundation", async (t) => {
  const require = createRequire(import.meta.url);
  const path = require.resolve("server-only");
  const original = require.cache[path];
  require.cache[path] = { exports: {} } as NodeModule;
  t.after(() => {
    if (original) require.cache[path] = original;
    else delete require.cache[path];
  });
  const { closeShift } = await import("./close-shift");

  await t.test("close persists server settlement, cash, timestamp and closing actor", async () => {
    const f = fixture();
    const input = { shiftId, countedCash: 122000, expectedCash: 1, cashVariance: 99, closedBy: "intruder" };
    const result = await closeShift(f.db, owner, input);
    assert.equal(result.expectedCash, 122000);
    assert.equal(result.cashVariance, 0);
    assert.equal(f.shift.status, "CLOSED");
    assert.equal(f.shift.expectedCash, 122000);
    assert.equal(f.shift.countedCash, 122000);
    assert.equal(f.shift.variance, 0);
    assert.ok(f.shift.closedAt instanceof Date);
    assert.equal(result.closedAt, f.shift.closedAt.toISOString());
    assert.equal(f.audits[0].data.actorId, owner.id);
    assert.equal((f.audits[0].data.details as Prisma.JsonObject).closingActorId, owner.id);
    assert.deepEqual(f.events, ["waiting", "locked", "settlement", "close"]);
  });

  await t.test("positive and negative variances preserve the discrepancy note", async () => {
    for (const variance of [-1000, 1000]) {
      const f = fixture();
      const result = await closeShift(f.db, owner, { shiftId, countedCash: 122000 + variance, discrepancyNote: " Count verified " });
      assert.equal(result.cashVariance, variance);
      assert.equal(f.shift.variance, variance);
      assert.equal(f.shift.closingNote, "Count verified");
    }
  });

  await t.test("duplicate close preserves the original closing values and audit", async () => {
    const f = fixture();
    await closeShift(f.db, owner, { shiftId, countedCash: 122000 });
    const before = { ...f.shift };
    await assert.rejects(closeShift(f.db, owner, { shiftId, countedCash: 0 }), { code: "SHIFT_NOT_OPEN" });
    assert.deepEqual(f.shift, before);
    assert.equal(f.audits.length, 1);
  });

  await t.test("other cashier is forbidden; admin must supply a reason", async () => {
    const f = fixture();
    const input = { shiftId, countedCash: 122000 };
    await assert.rejects(closeShift(f.db, { id: "other", role: "CASHIER" }, input), { code: "FORBIDDEN" });
    const admin: ShiftActor = { id: "admin", role: "ADMIN" };
    await assert.rejects(closeShift(f.db, admin, input), { code: "REASON_REQUIRED" });
    await closeShift(f.db, admin, { ...input, adminCloseReason: "Covering owner" });
    assert.equal(f.shift.cashierId, owner.id);
    assert.equal(f.audits[0].data.actorId, admin.id);
  });

  await t.test("invalid cash and missing discrepancy notes leave shift open", async () => {
    for (const countedCash of [-1, 0.5, NaN, Infinity, "122000", null, 2147483648]) {
      const f = fixture();
      await assert.rejects(closeShift(f.db, owner, { shiftId, countedCash }), { code: "INVALID_MONEY" });
      assert.equal(f.shift.status, "OPEN");
      assert.equal(f.audits.length, 0);
    }
    await assert.rejects(closeShift(fixture().db, owner, { shiftId, countedCash: 0 }), { code: "DISCREPANCY_NOTE_REQUIRED" });
  });

  await t.test("concurrent closes serialize: only one settles and commits", async () => {
    const f = fixture();
    const results = await Promise.allSettled([
      closeShift(f.db, owner, { shiftId, countedCash: 122000 }),
      closeShift(f.db, owner, { shiftId, countedCash: 123000, discrepancyNote: "Second count" }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.equal(rejected.reason.code, "SHIFT_NOT_OPEN");
    assert.equal(f.audits.length, 1);
    assert.equal(f.shift.countedCash, 122000);
    assert.equal(f.events.filter((event) => event === "settlement").length, 1);
    assert.deepEqual(f.events.slice(0, 2), ["waiting", "waiting"]);
  });

  await t.test("settlement connection failure cannot close or save zero totals", async () => {
    const f = fixture(true);
    await assert.rejects(closeShift(f.db, owner, { shiftId, countedCash: 122000 }), /Connection lost/);
    assert.equal(f.shift.status, "OPEN");
    assert.equal(f.shift.closedAt, null);
    assert.equal(f.audits.length, 0);
  });
});
