import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { admitAuthentication, pruneAuthenticationAttempts, throttleKey } from "../src/lib/auth/throttle";
import { hashPassword } from "../src/lib/auth/password";
import { resetUserPassword, changePassword } from "../src/lib/auth/recovery-service";

test("persistent authentication admission on isolated PostgreSQL", async t => {
  assert.notEqual(process.env.NODE_ENV, "production");
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/aroom_access_test_[a-f0-9]{32}$/);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  const second = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  assert.equal((await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`)[0].name, url.pathname.slice(1));
  const { prisma } = await import("../src/lib/db");
  const { authenticateCredentials } = await import("../src/lib/auth/credentials");
  const secret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = randomBytes(32).toString("base64");
  try {
    await t.test("missing or invalid dedicated secret blocks reset and password change before mutation", async () => {
      const before = process.env.AUTH_THROTTLE_HMAC_SECRET;
      const password = randomBytes(24).toString("base64url"), passwordHash = await hashPassword(password);
      const admin = await db.user.create({ data: { name: "Secret test", role: "ADMIN", loginIdentifier: randomUUID(), passwordHash } });
      const staff = await db.user.create({ data: { name: "Target", role: "CASHIER", loginIdentifier: randomUUID(), passwordHash } });
      const actor = { userId: admin.id, credentialsVersion: 1 };
      const count = await db.authThrottle.count();
      try {
        for (const value of [undefined, "", "malformed", Buffer.alloc(32).toString("base64")]) {
          if (value === undefined) delete process.env.AUTH_THROTTLE_HMAC_SECRET; else process.env.AUTH_THROTTLE_HMAC_SECRET = value;
          await assert.rejects(resetUserPassword(db, actor, { userId: staff.id, operationId: randomUUID(), expectedVersion: 1, adminPassword: password }), /Authentication unavailable/);
          await assert.rejects(changePassword(db, actor, { currentPassword: password, newPassword: "a unique changed credential", confirmation: "a unique changed credential" }), /Authentication unavailable/);
        }
        assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: admin.id } }), admin);
        assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: staff.id } }), staff);
        assert.equal(await db.authThrottle.count(), count);
        assert.equal(await db.auditLog.count({ where: { entityId: { in: [admin.id, staff.id] } } }), 0);
      } finally { if (before === undefined) delete process.env.AUTH_THROTTLE_HMAC_SECRET; else process.env.AUTH_THROTTLE_HMAC_SECRET = before; }
    });
    await t.test("two clients admit exactly ten concurrent login attempts; denial never extends window", async () => {
      const login = randomUUID();
      const results = await Promise.all(Array.from({ length: 30 }, (_, i) => admitAuthentication(i % 2 ? db : second, "LOGIN", login)));
      assert.equal(results.filter(Boolean).length, 10);
      const where = { scope_key: { scope: "LOGIN", key: throttleKey("LOGIN", login) } };
      const before = await db.authThrottle.findUniqueOrThrow({ where });
      assert.equal(before.attempts, 10);
      assert.equal(await admitAuthentication(second, "LOGIN", login), false);
      assert.deepEqual(await db.authThrottle.findUniqueOrThrow({ where }), before);
      assert.equal(await admitAuthentication(db, "LOGIN", randomUUID()), true);
      await db.authThrottle.update({ where, data: { expiresAt: new Date(0) } });
      assert.equal(await admitAuthentication(second, "LOGIN", login), true);
      assert.equal((await db.authThrottle.findUniqueOrThrow({ where })).attempts, 1);
    });
    await t.test("normalized unknown accounts share limits and store no raw identifier", async () => {
      const login = randomUUID();
      for (let i = 0; i < 12; i++) assert.equal(await authenticateCredentials(i % 2 ? ` ${login.toUpperCase()} ` : login, "wrong-password"), null);
      const stored = await db.authThrottle.findUniqueOrThrow({ where: { scope_key: { scope: "LOGIN", key: throttleKey("LOGIN", login) } } });
      assert.equal(stored.attempts, 10);
      assert.ok(!JSON.stringify(stored).includes(login));
    });
    await t.test("correct passwords cannot bypass exhaustion; other roles/accounts remain independent", async () => {
      const password = randomBytes(24).toString("base64url");
      const user = await db.user.create({ data: { name: "Throttle test", loginIdentifier: randomUUID(), role: "ADMIN", passwordHash: await hashPassword(password) } });
      for (let i = 0; i < 10; i++) assert.equal(await authenticateCredentials(user.loginIdentifier, "incorrect"), null);
      assert.equal(await authenticateCredentials(user.loginIdentifier, password), null);
      await db.authThrottle.update({ where: { scope_key: { scope: "LOGIN", key: throttleKey("LOGIN", user.loginIdentifier) } }, data: { expiresAt: new Date(0) } });
      assert.ok(await authenticateCredentials(user.loginIdentifier, password));
      for (const role of ["CASHIER", "FINANCE", "STOCK_MANAGEMENT", "PROCUREMENT"] as const) {
        const employee = await db.user.create({ data: { name: "Independent", role, loginIdentifier: randomUUID(), passwordHash: user.passwordHash } });
        assert.ok(await authenticateCredentials(employee.loginIdentifier, password));
      }
    });
    await t.test("wrong ADMIN reauthentication persists outside rollback and cannot bypass using targets or UUIDs", async () => {
      const password = randomBytes(24).toString("base64url"), passwordHash = await hashPassword(password);
      const admin = await db.user.create({ data: { name: "Reauth", role: "ADMIN", loginIdentifier: randomUUID(), passwordHash } });
      const staff = await db.user.create({ data: { name: "Target", role: "CASHIER", loginIdentifier: randomUUID(), passwordHash } });
      const actor = { userId: admin.id, credentialsVersion: 1 };
      for (let i = 0; i < 5; i++) await assert.rejects(resetUserPassword(db, actor, { userId: i % 2 ? randomUUID() : staff.id, operationId: randomUUID(), expectedVersion: 1, adminPassword: "wrong" }), { code: "REAUTHENTICATE" });
      await assert.rejects(resetUserPassword(db, actor, { userId: staff.id, operationId: randomUUID(), expectedVersion: 1, adminPassword: password }), /Authentication unavailable/);
      await assert.rejects(changePassword(db, actor, { currentPassword: password, newPassword: "a unique changed credential", confirmation: "a unique changed credential" }), /Authentication unavailable/);
      assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: staff.id } }), staff);
      assert.equal(await db.auditLog.count({ where: { entityId: staff.id } }), 0);
    });
    await t.test("reauth concurrent reservations admit five and scope is independent of login", async () => {
      const id = randomUUID();
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => admitAuthentication(i % 2 ? db : second, "REAUTH", id)));
      assert.equal(results.filter(Boolean).length, 5);
      assert.equal(await admitAuthentication(db, "LOGIN", id), true);
    });
    await t.test("cleanup is bounded and preserves current enforcement", async () => {
      await db.authThrottle.createMany({ data: Array.from({ length: 501 }, () => ({ scope: "LOGIN", key: randomBytes(32).toString("hex"), attempts: 1, expiresAt: new Date(0) })) });
      const current = await db.authThrottle.count({ where: { expiresAt: { gt: new Date() } } });
      assert.equal(await pruneAuthenticationAttempts(db), 500);
      assert.equal(await db.authThrottle.count({ where: { expiresAt: new Date(0) } }), 1);
      assert.equal(await db.authThrottle.count({ where: { expiresAt: { gt: new Date() } } }), current);
    });
    await t.test("database enforces scope, digest and attempt constraints", async () => {
      for (const patch of [{ scope: "IP" }, { key: "raw-user" }, { attempts: 0 }, { attempts: 11 }, { scope: "REAUTH", attempts: 6 }]) {
        await assert.rejects(db.authThrottle.create({ data: { scope: "LOGIN", key: randomBytes(32).toString("hex"), attempts: 1, expiresAt: new Date(), ...patch } }));
      }
    });
  } finally {
    if (secret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = secret;
    await prisma.$disconnect(); await db.$disconnect(); await second.$disconnect();
  }
});
