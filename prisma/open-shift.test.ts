import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../src/generated/prisma/client";
import { findActiveShift, getActiveRegisterState, openShift, type OpenShiftResult } from "../src/lib/shifts/service";
import type { ShiftActor } from "../src/lib/shifts/domain";

test("open shift PostgreSQL integration with development users and restored fixtures", async (t) => {
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.ok(process.env.DATABASE_URL);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const rollback = new Error("rollback fixtures");
  try {
    const users = await db.user.findMany({ where: { active: true }, select: { id: true, role: true }, orderBy: { id: "asc" } });
    const cashier = users.find((u) => u.role === "CASHIER");
    const admin = users.find((u) => u.role === "ADMIN");
    assert.ok(cashier && admin, "Requires existing active development CASHIER and ADMIN");
    const before = await db.shift.findMany({ where: { status: "OPEN" } });
    await t.test("audit insert failure rolls back the new shift", async () => {
      const id = randomUUID();
      const failure = new Error("simulated audit storage failure");
      const scoped = {
        $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => db.$transaction(async (tx) => {
          await tx.$executeRaw`LOCK TABLE "Shift" IN EXCLUSIVE MODE`;
          await tx.shift.updateMany({ where: { status: "OPEN" }, data: { status: "CLOSED" } });
          return fn(new Proxy(tx, { get(target, key) {
            if (key === "auditLog") return { create: async () => { throw failure; } };
            if (key === "shift") return new Proxy(tx.shift, { get(delegate, method) {
              if (method === "create") return (args: Prisma.ShiftCreateArgs) => delegate.create({ ...args, data: { ...args.data, id } });
              return Reflect.get(delegate, method);
            } });
            return Reflect.get(target, key);
          } }));
        }),
      } as unknown as PrismaClient;
      await assert.rejects(openShift(scoped, cashier, 0), (error: unknown) => error === failure);
      assert.equal(await db.shift.count({ where: { id } }), 0);
      assert.equal(await db.auditLog.count({ where: { entityId: id } }), 0);
      assert.deepEqual(await db.shift.findMany({ where: { status: "OPEN" } }), before);
    });
    await t.test("opening, recovery, permissions and audit atomicity roll back", async () => {
      await assert.rejects(db.$transaction(async (tx) => {
        await tx.$executeRaw`LOCK TABLE "Shift" IN EXCLUSIVE MODE`;
        await tx.shift.updateMany({ where: { status: "OPEN" }, data: { status: "CLOSED" } });
        const scoped = { $transaction: (fn: (client: Prisma.TransactionClient) => unknown) => fn(tx), shift: tx.shift } as unknown as PrismaClient;
        assert.equal((await getActiveRegisterState(tx, cashier)).state, "EMPTY");
        for (const actor of [cashier, admin]) {
          const opened = await openShift(scoped, actor, "0");
          assert.equal(opened.state, "CREATED");
          assert.equal(opened.shift.cashierId, actor.id);
          for (const key of ["closedAt", "expectedCash", "countedCash", "variance", "closingNote"] as const) assert.equal(opened.shift[key], null);
          const resumed = await openShift(scoped, { ...actor }, "100000");
          assert.equal(resumed.state, "EXISTING");
          assert.deepEqual(resumed.shift, opened.shift);
          assert.equal((await findActiveShift(tx))?.id, opened.shift.id);
          const other: ShiftActor = actor.id === cashier.id ? admin : cashier;
          await assert.rejects(openShift(scoped, other, 1), { code: "REGISTER_OCCUPIED" });
          const view = await getActiveRegisterState(tx, other);
          assert.equal(view.state, other.role === "ADMIN" ? "ADMIN_VIEW" : "OCCUPIED");
          assert.equal(view.shift?.mayOperate, other.role === "ADMIN");
          assert.equal(view.shift?.ownsShift, false);
          assert.equal("openingCash" in view.shift!, other.role === "ADMIN");
          const own = await getActiveRegisterState(tx, actor);
          assert.equal(own.shift?.ownsShift, true);
          assert.equal(own.shift?.mayOperate, true);
          const audits = await tx.auditLog.findMany({ where: { entityId: opened.shift.id } });
          assert.equal(audits.length, 1);
          assert.equal(audits[0].actorId, actor.id);
          assert.equal(audits[0].action, "SHIFT_OPENED");
          assert.equal(audits[0].entityType, "Shift");
          assert.deepEqual(audits[0].details, { shiftOwnerId: actor.id, openingCash: 0, openedAt: opened.shift.openedAt.toISOString() });
          assert.equal(await tx.shift.count({ where: { status: "OPEN" } }), 1);
          await tx.auditLog.deleteMany({ where: { entityId: opened.shift.id } });
          await tx.shift.delete({ where: { id: opened.shift.id } });
        }
        throw rollback;
      }), (error: unknown) => error === rollback);
      assert.deepEqual(await db.shift.findMany({ where: { status: "OPEN" } }), before);
    });

    await t.test("real simultaneous requests recover after unique conflict with one audit", async () => {
      assert.equal(before.length, 0, "Concurrency verification needs an idle development register; existing shifts are never removed");
      for (const sameOwner of [true, false]) {
        const ids: string[] = [randomUUID(), randomUUID()];
        let arrivals = 0;
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => { release = resolve; });
        const clients = ids.map((id) => ({
          shift: db.shift,
          $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => db.$transaction(async (tx) => {
            const scoped = new Proxy(tx, { get(target, key) {
              if (key !== "shift") return Reflect.get(target, key);
              return new Proxy(tx.shift, { get(delegate, method) {
                if (method === "findFirst") return async () => {
                  const active = await findActiveShift(tx);
                  if (++arrivals === 2) release();
                  await barrier;
                  return active;
                };
                if (method === "create") return (args: Prisma.ShiftCreateArgs) => delegate.create({ ...args, data: { ...args.data, id } });
                return Reflect.get(delegate, method);
              } });
            } });
            return fn(scoped);
          }, { timeout: 10000 }),
        }) as unknown as PrismaClient);
        try {
          const results: PromiseSettledResult<OpenShiftResult>[] = await Promise.allSettled([
            openShift(clients[0], cashier, 100000),
            openShift(clients[1], sameOwner ? cashier : admin, 200000),
          ]);
          const created = results.filter((r) => r.status === "fulfilled" && r.value.state === "CREATED");
          assert.equal(created.length, 1);
          if (sameOwner) {
            assert.equal(results.filter((r) => r.status === "fulfilled" && r.value.state === "EXISTING").length, 1);
            assert.ok(results.every((r) => r.status === "fulfilled"));
          } else {
            const loser = results.find((r) => r.status === "rejected");
            assert.ok(loser && loser.status === "rejected");
            assert.equal(loser.reason.code, "REGISTER_OCCUPIED");
          }
          assert.equal(await db.shift.count({ where: { status: "OPEN" } }), 1);
          assert.equal(await db.auditLog.count({ where: { entityId: { in: ids }, action: "SHIFT_OPENED" } }), 1);
          const fresh = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
          try {
            const active = await findActiveShift(fresh);
            assert.ok(active && ids.includes(active.id));
            const owner = users.find((u) => u.id === active.cashierId)!;
            const recovered = await openShift(fresh, owner, 0);
            assert.equal(recovered.state, "EXISTING");
            assert.deepEqual(recovered.shift, active);
          } finally { await fresh.$disconnect(); }
        } finally {
          // Only UUIDs reserved by this test can be deleted. Both requests have settled.
          await db.$transaction(async (tx) => {
            await tx.auditLog.deleteMany({ where: { entityId: { in: ids }, action: "SHIFT_OPENED" } });
            await tx.shift.deleteMany({ where: { id: { in: ids } } });
          });
        }
        assert.equal(await db.shift.count({ where: { id: { in: ids } } }), 0);
        assert.equal(await db.auditLog.count({ where: { entityId: { in: ids } } }), 0);
      }
      assert.deepEqual(await db.shift.findMany({ where: { status: "OPEN" } }), before);
    });
  } finally { await db.$disconnect(); }
});
