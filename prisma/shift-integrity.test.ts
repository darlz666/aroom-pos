import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { findActiveShift, lockShift } from "../src/lib/shifts/service";

test("PostgreSQL rejects a second OPEN shift across owners; CLOSED shifts are unrestricted", async () => {
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.ok(process.env.DATABASE_URL);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const rollback = new Error("Rollback fixtures");
  try {
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRaw`LOCK TABLE "Shift" IN EXCLUSIVE MODE`;
      // Existing local data is restored by rollback; no fixtures are committed.
      await tx.shift.updateMany({ where: { status: "OPEN" }, data: { status: "CLOSED" } });
      assert.equal(await findActiveShift(tx), null);
      const owners = await Promise.all([0, 1].map(() => tx.user.create({ data: {
        name: "Shift integrity fixture", loginIdentifier: randomUUID(), passwordHash: "unused", role: "CASHIER",
      } })));
      const first = await tx.shift.create({ data: { cashierId: owners[0].id, openingCash: 0 } });
      assert.equal((await findActiveShift(tx))?.id, first.id);
      assert.equal((await lockShift(tx, first.id))?.status, "OPEN");
      assert.equal(await lockShift(tx, randomUUID()), null);
      for (const owner of owners) {
        await tx.$executeRawUnsafe("SAVEPOINT duplicate_open");
        await assert.rejects(tx.shift.create({ data: { cashierId: owner.id, openingCash: 0 } }), { code: "P2002" });
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT duplicate_open");
      }
      const closed = [];
      for (const owner of [owners[0], owners[0], owners[1]]) {
        closed.push(await tx.shift.create({ data: { cashierId: owner.id, openingCash: 0, status: "CLOSED", closedAt: new Date() } }));
      }
      await tx.$executeRawUnsafe("SAVEPOINT duplicate_update");
      await assert.rejects(tx.shift.update({ where: { id: closed[0].id }, data: { status: "OPEN" } }), { code: "P2002" });
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT duplicate_update");
      await tx.shift.update({ where: { id: first.id }, data: { status: "CLOSED", closedAt: new Date() } });
      assert.equal((await lockShift(tx, first.id))?.status, "CLOSED");
      await tx.shift.create({ data: { cashierId: owners[1].id, openingCash: 0 } });
      assert.equal(await tx.shift.count({ where: { status: "OPEN" } }), 1);
      throw rollback;
    }), (e: unknown) => e === rollback);
  } finally {
    await db.$disconnect();
  }
});
