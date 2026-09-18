import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../src/generated/prisma/client";
import { verifyPassword } from "../src/lib/auth/password";
import { changeUserRole, createUser, listUsers, setUserActive } from "../src/lib/users/service";

test("Access Management PostgreSQL transactions, audits, retries and concurrent access changes", async t => {
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.ok(process.env.DATABASE_URL);
  const url = new URL(process.env.DATABASE_URL);
  assert.match(url.pathname, /^\/aroom_access_test_/);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  const ids: string[] = [];
  const fixture = async (role: "ADMIN" | "CASHIER" = "ADMIN") => {
    const user = await db.user.create({ data: { name: "Test", loginIdentifier: randomUUID(), passwordHash: "unused", role } });
    ids.push(user.id); return user;
  };
  try {
    const admin = await fixture(), other = await fixture();
    const password = " unchanged password ";
    const login = randomUUID();
    const user = await createUser(db, admin, { name: " Staff ", loginIdentifier: ` ${login.toUpperCase()} `, password, role: "FINANCE" });
    ids.push(user.id);
    await t.test("safe DTOs, Argon2 hashing, normalized unique login and secret-free audit", async () => {
      assert.deepEqual(Object.keys(user).sort(), ["active", "id", "loginIdentifier", "name", "role"]);
      assert.equal(user.name, "Staff"); assert.equal(user.loginIdentifier, login); assert.equal(user.active, true);
      const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      assert.ok(await verifyPassword(stored.passwordHash, password));
      for (const entry of await listUsers(db, admin)) assert.deepEqual(Object.keys(entry).sort(), Object.keys(user).sort());
      await assert.rejects(createUser(db, admin, { name: "Duplicate", loginIdentifier: login.toUpperCase(), password, role: "ADMIN" }), { code: "DUPLICATE_LOGIN" });
      const audit = await db.auditLog.findMany({ where: { entityId: user.id } });
      assert.equal(audit.length, 1); assert.equal(audit[0].action, "USER_CREATED"); assert.equal(audit[0].actorId, admin.id);
      assert.deepEqual(audit[0].details, { role: "FINANCE", active: true });
      assert.ok(!JSON.stringify(audit).includes(password)); assert.ok(!JSON.stringify(audit).includes(stored.passwordHash));
    });
    await t.test("all role changes and active retries are audited once and preserve identity", async () => {
      for (const role of ["STOCK_MANAGEMENT", "CASHIER", "ADMIN", "FINANCE"] as const) {
        assert.equal((await changeUserRole(db, admin, { userId: user.id, role })).role, role);
        await changeUserRole(db, admin, { userId: user.id, role });
      }
      for (const active of [false, true]) {
        assert.equal((await setUserActive(db, admin, { userId: user.id, active })).active, active);
        await setUserActive(db, admin, { userId: user.id, active });
      }
      assert.equal(await db.auditLog.count({ where: { entityId: user.id } }), 7);
      const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: user.id, action: "USER_ROLE_CHANGED" }, orderBy: { createdAt: "asc" } });
      assert.deepEqual(audit.details, { before: { role: "FINANCE", active: true }, after: { role: "STOCK_MANAGEMENT", active: true } });
      const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      assert.ok(await verifyPassword(stored.passwordHash, password)); assert.equal(stored.loginIdentifier, login);
    });
    await t.test("deny non-admin, stale, inactive and missing actors; reject self changes and missing targets", async () => {
      for (const role of ["CASHIER", "FINANCE", "STOCK_MANAGEMENT"] as const) {
        await assert.rejects(listUsers(db, { id: admin.id, role }), { code: "FORBIDDEN" });
      }
      for (const actor of [{ id: user.id, role: "ADMIN" as const }, { id: randomUUID(), role: "ADMIN" as const }]) {
        await assert.rejects(listUsers(db, actor), { code: "FORBIDDEN" });
        await assert.rejects(setUserActive(db, actor, { userId: user.id, active: false }), { code: "FORBIDDEN" });
      }
      await setUserActive(db, admin, { userId: other.id, active: false });
      await assert.rejects(listUsers(db, other), { code: "FORBIDDEN" });
      await setUserActive(db, admin, { userId: other.id, active: true });
      await assert.rejects(setUserActive(db, admin, { userId: admin.id, active: false }), { code: "SELF_ACCESS_CHANGE" });
      await assert.rejects(changeUserRole(db, admin, { userId: admin.id, role: "CASHIER" }), { code: "SELF_ACCESS_CHANGE" });
      await assert.rejects(changeUserRole(db, admin, { userId: randomUUID(), role: "ADMIN" }), { code: "NOT_FOUND" });
    });
    await t.test("audit failure rolls back creation and access changes", async () => {
      const broken = { $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => db.$transaction(tx => fn(new Proxy(tx, {
        get(target, key) { return key === "auditLog" ? { create: async () => { throw new Error("audit unavailable"); } } : Reflect.get(target, key); },
      }))), user: db.user } as unknown as PrismaClient;
      await assert.rejects(setUserActive(broken, admin, { userId: user.id, active: false }), /audit unavailable/);
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: user.id } })).active, true);
      const loginIdentifier = randomUUID();
      await assert.rejects(createUser(broken, admin, { name: "Rollback", loginIdentifier, password, role: "CASHIER" }), /audit unavailable/);
      assert.equal(await db.user.count({ where: { loginIdentifier } }), 0);
    });
    await t.test("concurrent duplicate creation produces one user and one audit", async () => {
      const loginIdentifier = randomUUID();
      const result = await Promise.allSettled([1, 2].map(() => createUser(db, admin, { name: "Race", loginIdentifier, password, role: "STOCK_MANAGEMENT" })));
      assert.equal(result.filter(r => r.status === "fulfilled").length, 1);
      const saved = await db.user.findUniqueOrThrow({ where: { loginIdentifier } }); ids.push(saved.id);
      assert.equal(await db.auditLog.count({ where: { entityId: saved.id } }), 1);
      assert.equal((result.find(r => r.status === "rejected") as PromiseRejectedResult).reason.code, "DUPLICATE_LOGIN");
    });
    await t.test("competing admins cannot remove each other's access; waiter rechecks actor", async () => {
      for (const mode of ["role", "active"] as const) {
        await db.user.updateMany({ where: { id: { in: [admin.id, other.id] } }, data: { active: true, role: "ADMIN" } });
        const remove = (actor: typeof admin, target: typeof admin) => mode === "role"
          ? changeUserRole(db, actor, { userId: target.id, role: "CASHIER" })
          : setUserActive(db, actor, { userId: target.id, active: false });
        const results = await Promise.allSettled([remove(admin, other), remove(other, admin)]);
        assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
        assert.equal((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason.code, "FORBIDDEN");
        assert.equal(await db.user.count({ where: { id: { in: [admin.id, other.id] }, active: true, role: "ADMIN" } }), 1);
      }
    });
    await t.test("last active admin remains protected", async () => {
      // Isolated test database only; restore all pre-existing admin flags afterward.
      const previous = await db.user.findMany({ where: { role: "ADMIN", active: true } });
      try {
        await db.user.updateMany({ where: { role: "ADMIN" }, data: { active: false } });
        await db.user.update({ where: { id: admin.id }, data: { role: "ADMIN", active: true } });
        await assert.rejects(setUserActive(db, admin, { userId: admin.id, active: false }), { code: "LAST_ADMIN" });
        await assert.rejects(changeUserRole(db, admin, { userId: admin.id, role: "FINANCE" }), { code: "LAST_ADMIN" });
      } finally {
        await db.user.updateMany({ where: { id: { in: previous.map(u => u.id) } }, data: { active: true } });
      }
    });
  } finally {
    await db.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: ids } }] } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  }
});
