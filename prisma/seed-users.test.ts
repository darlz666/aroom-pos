import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { verifyPassword } from "../src/lib/auth/password";
import { developmentUserIds, readDevelopmentUsers, seedUsers } from "./seed-users";

function environment(): NodeJS.ProcessEnv {
  const suffix = randomUUID();
  return {
    NODE_ENV: "development",
    AROOM_DEV_ADMIN_NAME: "Development Admin",
    AROOM_DEV_ADMIN_LOGIN: `  ADMIN-${suffix}  `,
    AROOM_DEV_ADMIN_PASSWORD: randomBytes(24).toString("hex"),
    AROOM_DEV_CASHIER_NAME: "Development Cashier",
    AROOM_DEV_CASHIER_LOGIN: `  CASHIER-${suffix}  `,
    AROOM_DEV_CASHIER_PASSWORD: randomBytes(24).toString("hex"),
  };
}

test("development credentials normalize logins and reject missing/invalid inputs and production", () => {
  const env = environment();
  assert.equal(readDevelopmentUsers(env)[0].loginIdentifier, env.AROOM_DEV_ADMIN_LOGIN!.trim().toLowerCase());
  for (const role of ["ADMIN", "CASHIER"]) {
    for (const field of ["NAME", "LOGIN", "PASSWORD"]) {
      const key = `AROOM_DEV_${role}_${field}`;
      for (const value of [undefined, "", " "]) {
        assert.throws(() => readDevelopmentUsers({ ...env, [key]: value }), new RegExp(key));
      }
    }
    for (const value of ["x".repeat(11), "x".repeat(129)]) {
      assert.throws(() => readDevelopmentUsers({ ...env, [`AROOM_DEV_${role}_PASSWORD`]: value }), /12 to 128/);
    }
  }
  assert.throws(() => readDevelopmentUsers({ ...env, NODE_ENV: "production" }), /production/);
  assert.throws(() => readDevelopmentUsers({ ...env, AROOM_DEV_CASHIER_LOGIN: env.AROOM_DEV_ADMIN_LOGIN }), /distinct/);
});

test("user seed restores both identities, preserves unrelated data, and rolls back", async () => {
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.ok(process.env.DATABASE_URL, "A development DATABASE_URL is required");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const rollback = new Error("Rollback test changes");
  try {
    await assert.rejects(prisma.$transaction(async (tx) => {
      const otherCounts = () => Promise.all([
        tx.category.count(), tx.product.count(), tx.shift.count(), tx.order.count(),
        tx.orderItem.count(), tx.payment.count(), tx.paymentNotification.count(), tx.auditLog.count(),
      ]);
      const before = await otherCounts();
      const env = environment();
      await assert.rejects(seedUsers(tx, { ...env, NODE_ENV: "production" }), /production/);
      const unrelated = await tx.user.create({ data: {
        name: "Unrelated test user", loginIdentifier: randomUUID(),
        passwordHash: "unusable-test-hash", role: "CASHIER", active: false,
      } });
      const preserved = await tx.user.findMany({ where: { id: { notIn: Object.values(developmentUserIds) } }, orderBy: { id: "asc" } });
      await seedUsers(tx, env);
      const count = await tx.user.count();
      for (const role of ["ADMIN", "CASHIER"] as const) {
        await tx.user.update({ where: { id: developmentUserIds[role] }, data: {
          role: role === "ADMIN" ? "CASHIER" : "ADMIN", active: false, name: "Changed",
        } });
      }
      const next = environment();
      await seedUsers(tx, next);
      await seedUsers(tx, next);
      assert.equal(await tx.user.count(), count);
      for (const expected of readDevelopmentUsers(next)) {
        const saved = await tx.user.findUniqueOrThrow({ where: { id: expected.id } });
        assert.equal(saved.role, expected.role);
        assert.equal(saved.active, true);
        assert.equal(saved.name, expected.name);
        assert.equal(saved.loginIdentifier, expected.loginIdentifier);
        assert.ok(saved.passwordHash.startsWith("$argon2id$"));
        assert.ok(saved.passwordHash !== expected.password);
        assert.ok(await verifyPassword(saved.passwordHash, expected.password));
        assert.equal(await verifyPassword(saved.passwordHash, env[`AROOM_DEV_${expected.role}_PASSWORD`]!), false);
      }
      await assert.rejects(seedUsers(tx, { ...next, AROOM_DEV_CASHIER_LOGIN: unrelated.loginIdentifier }), /another user/);
      assert.deepEqual(await tx.user.findMany({ where: { id: { notIn: Object.values(developmentUserIds) } }, orderBy: { id: "asc" } }), preserved);
      assert.deepEqual(await otherCounts(), before);
      throw rollback;
    }, { timeout: 15000 }), (error: unknown) => error === rollback);
  } finally {
    await prisma.$disconnect();
  }
});
