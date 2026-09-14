import assert from "node:assert/strict";
import { test } from "node:test";
import type { Prisma, PrismaClient, Shift } from "../../generated/prisma/client";
import { closeShift } from "./service";
import { MAX_SHIFT_MONEY, type ShiftActor } from "./domain";

const shiftId = "00000000-0000-4000-8000-000000000001";
const owner: ShiftActor = { id: "owner", role: "CASHIER" };

function fixture(options: { status?: "OPEN" | "CLOSED" | null; openingCash?: number; cashSum?: number | null; unpaid?: boolean; pending?: boolean; auditFailure?: Error } = {}) {
  const events: string[] = [];
  let shift = { id: shiftId, cashierId: owner.id, status: options.status === undefined ? "OPEN" : options.status,
    openingCash: options.openingCash ?? 100, closedAt: null, expectedCash: null, countedCash: null, variance: null, closingNote: null } as Shift;
  const audits: Prisma.AuditLogCreateArgs[] = [];
  const tx = {
    $queryRaw: async (sql: TemplateStringsArray, id: string) => {
      events.push("lock");
      assert.match(sql.join("?"), /WHERE "id" = \?::uuid FOR UPDATE/);
      assert.equal(id, shiftId);
      return options.status === null ? [] : [shift];
    },
    order: { findFirst: async (args: unknown) => {
      events.push("unpaid");
      assert.deepEqual(args, { where: { shiftId, status: "UNPAID" }, select: { id: true } });
      return options.unpaid ? { id: "order" } : null;
    } },
    payment: {
      findFirst: async (args: unknown) => {
        events.push("pending");
        assert.deepEqual(args, { where: { order: { shiftId }, status: "PENDING" }, select: { id: true } });
        return options.pending ? { id: "payment" } : null;
      },
      aggregate: async (args: unknown) => {
        events.push("cash");
        assert.deepEqual(args, { where: { order: { shiftId }, method: "CASH", status: "SUCCEEDED" }, _sum: { amount: true } });
        return { _sum: { amount: options.cashSum ?? null } };
      },
    },
    shift: { update: async ({ where, data }: Prisma.ShiftUpdateArgs) => {
      events.push("close");
      assert.deepEqual(where, { id: shiftId });
      assert.equal("cashierId" in data, false);
      shift = { ...shift, ...data } as Shift;
      return shift;
    } },
    auditLog: { create: async (args: Prisma.AuditLogCreateArgs) => {
      events.push("audit");
      if (options.auditFailure) throw options.auditFailure;
      audits.push(args);
    } },
  };
  const db = { $transaction: async (fn: (client: typeof tx) => Promise<unknown>, config: unknown) => {
    assert.deepEqual(config, { isolationLevel: "ReadCommitted" });
    const before = shift;
    try { return await fn(tx); } catch (error) { shift = before; throw error; }
  } } as unknown as PrismaClient;
  return { db, events, audits, get shift() { return shift; } };
}

test("owners of both roles close with zero counted cash and safe result; lock precedes reads and atomic writes", async () => {
  for (const role of ["CASHIER", "ADMIN"] as const) {
    const f = fixture({ openingCash: 0 });
    const result = await closeShift(f.db, { ...owner, role }, { shiftId, countedCash: 0 });
    assert.equal(result.status, "CLOSED");
    assert.equal(result.cashVariance, 0);
    assert.equal(result.expectedCash, 0);
    assert.equal(result.discrepancyNote, null);
    assert.equal("cashierId" in result, false);
    assert.deepEqual(f.events, ["lock", "unpaid", "pending", "cash", "close", "audit"]);
    assert.equal(f.audits.length, 1);
    assert.equal(f.audits[0].data.action, "SHIFT_CLOSED");
    assert.equal(f.shift.cashierId, owner.id);
    const before = { ...f.shift };
    await assert.rejects(closeShift(f.db, { ...owner, role }, { shiftId, countedCash: 1, discrepancyNote: "retry" }), { code: "SHIFT_NOT_OPEN" });
    assert.deepEqual(f.shift, before);
    assert.equal(f.audits.length, 1);
  }
});

test("cashier cannot close another owner; missing and closed shifts reject before reads", async () => {
  const f = fixture();
  await assert.rejects(closeShift(f.db, { id: "other", role: "CASHIER" }, { shiftId, countedCash: 100 }), { code: "FORBIDDEN" });
  assert.deepEqual(f.events, ["lock"]);
  for (const status of [null, "CLOSED"] as const) {
    const f = fixture({ status });
    await assert.rejects(closeShift(f.db, owner, { shiftId, countedCash: 100 }), { code: "SHIFT_NOT_OPEN" });
    assert.deepEqual(f.events, ["lock"]);
  }
});

test("admin other-owner reason is mandatory independently of discrepancy and retained separately", async () => {
  const actor: ShiftActor = { id: "admin", role: "ADMIN" };
  for (const adminCloseReason of [undefined, null, "", " \t\n", 12]) {
    const f = fixture();
    await assert.rejects(closeShift(f.db, actor, { shiftId, countedCash: 100, discrepancyNote: "not a reason", adminCloseReason }), { code: "REASON_REQUIRED" });
    assert.equal(f.shift.status, "OPEN");
  }
  const f = fixture();
  const result = await closeShift(f.db, actor, { shiftId, countedCash: 90, discrepancyNote: " short drawer ", adminCloseReason: " owner left " });
  assert.equal(result.cashVariance, -10);
  assert.equal(f.shift.closingNote, "short drawer");
  assert.deepEqual(f.audits[0].data.details, {
    shiftOwnerId: owner.id, closingActorId: actor.id, expectedCash: 100, countedCash: 90,
    variance: -10, adminClosedOtherOwner: true, discrepancyNote: "short drawer", adminCloseReason: "owner left",
  });
});

test("counted cash rejects missing, malformed, negative, fractional and overflow values", async () => {
  for (const countedCash of [undefined, null, "0", "abc", -1, 0.5, NaN, Infinity, MAX_SHIFT_MONEY + 1, {}, true]) {
    const f = fixture();
    await assert.rejects(closeShift(f.db, owner, { shiftId, countedCash }), { code: "INVALID_MONEY" });
    assert.equal(f.shift.status, "OPEN");
    assert.equal(f.audits.length, 0);
  }
  const f = fixture({ openingCash: MAX_SHIFT_MONEY });
  assert.equal((await closeShift(f.db, owner, { shiftId, countedCash: MAX_SHIFT_MONEY })).cashVariance, 0);
});

test("expected cash adds persisted successful cash amount and rejects overflow", async () => {
  const f = fixture({ cashSum: 250 });
  const result = await closeShift(f.db, owner, { shiftId, countedCash: 400, discrepancyNote: " extra " });
  assert.equal(result.expectedCash, 350);
  assert.equal(result.cashVariance, 50);
  for (const options of [{ cashSum: MAX_SHIFT_MONEY }, { cashSum: MAX_SHIFT_MONEY + 1 }]) {
    await assert.rejects(closeShift(fixture(options).db, owner, { shiftId, countedCash: 0 }), { code: "INVALID_MONEY" });
  }
});

test("unpaid orders and pending payments independently block without any mutations", async () => {
  for (const options of [{ unpaid: true }, { pending: true }, { unpaid: true, pending: true }]) {
    const f = fixture(options);
    await assert.rejects(closeShift(f.db, owner, { shiftId, countedCash: 100 }), { code: "UNRESOLVED_TRANSACTIONS" });
    assert.deepEqual(f.events, ["lock", "unpaid", "pending"]);
    assert.equal(f.shift.status, "OPEN");
  }
});

test("nonzero variance requires its own nonblank note; invalid optional notes and IDs fail safely", async () => {
  for (const discrepancyNote of [undefined, null, "", " \n\t"]) {
    await assert.rejects(closeShift(fixture().db, owner, { shiftId, countedCash: 0, discrepancyNote, adminCloseReason: "not a discrepancy" }), { code: "DISCREPANCY_NOTE_REQUIRED" });
  }
  for (const fields of [{ discrepancyNote: {} }, { adminCloseReason: 1 }, { shiftId: "bad-id" }]) {
    await assert.rejects(closeShift(fixture().db, owner, { shiftId, countedCash: 100, ...fields }), { code: "INVALID_INPUT" });
  }
});

test("audit storage failure propagates and rolls back reconciliation", async () => {
  const failure = new Error("audit unavailable");
  const f = fixture({ auditFailure: failure });
  const before = { ...f.shift };
  await assert.rejects(closeShift(f.db, owner, { shiftId, countedCash: 100 }), (error: unknown) => error === failure);
  assert.deepEqual(f.shift, before);
  assert.equal(f.audits.length, 0);
});
