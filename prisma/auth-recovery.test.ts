import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma, type UserRole } from "../src/generated/prisma/client";
import { hashPassword, verifyPassword } from "../src/lib/auth/password";
import { resetUserPassword, readResetStatus, changePassword } from "../src/lib/auth/recovery-service";
import { setUserActive, changeUserRole } from "../src/lib/users/service";

test("credential recovery on positively identified disposable PostgreSQL", async t => {
  assert.notEqual(process.env.NODE_ENV, "production");
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/aroom_access_test_[a-f0-9]{32}$/);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  const [identity] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  assert.equal(identity.name, url.pathname.slice(1));
  // Each scenario starts a separate throttle window; dedicated throttling tests
  // exercise exhaustion across calls, retries, failures and concurrent clients.
  t.beforeEach(async () => { await db.authThrottle.deleteMany(); });
  const require = createRequire(import.meta.url);
  const navigationPath = require.resolve("next/navigation"), previousNavigation = require.cache[navigationPath];
  require("next/dist/client/components/navigation.react-server");
  require.cache[navigationPath] = require.cache[require.resolve("next/dist/client/components/navigation.react-server")];
  const originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = randomBytes(32).toString("base64");
  let cookie: string | undefined;
  t.mock.method(require("next/headers"), "cookies", async () => ({ get: () => cookie ? { value: cookie } : undefined, set: (_name: string, value: string) => { cookie = value; } }));
  const { prisma } = await import("../src/lib/db");
  const { authenticateCredentials } = await import("../src/lib/auth/credentials");
  const { loginAction, logoutAction } = await import("../src/lib/auth/actions");
  const { getCurrentUser, getPasswordChangeUser } = await import("../src/lib/auth/current-user");
  const { requireRole, requireOperator, requireInventoryManager, requireFinanceManager, requireProcurementReader } = await import("../src/lib/auth/authorization");
  const { signSessionToken } = await import("../src/lib/auth/session-token");
  const { resetPasswordAction, changePasswordAction } = await import("../src/lib/auth/recovery-actions");
  const password = randomBytes(24).toString("base64url");
  const fixture = (role: UserRole = "CASHIER", active = true) => db.user.create({ data: { name: "Recovery fixture", loginIdentifier: randomUUID(), passwordHash: sharedHash, role, active } });
  const sharedHash = await hashPassword(password);
  const admin = await fixture("ADMIN"), second = await fixture("ADMIN");
  const actor = { userId: admin.id, credentialsVersion: 1 };
  const request = (userId: string, expectedVersion = 1) => ({ userId, expectedVersion, operationId: randomUUID(), adminPassword: password });
  const session = async (userId: string, credentialsVersion = 1) => { cookie = await signSessionToken({ userId, credentialsVersion }); };
  const redirects = (path: string) => (error: unknown) => String((error as { digest?: string }).digest).includes(`;${path};`);
  try {
    await t.test("only a current unrestricted ADMIN with matching version and password may reset", async () => {
      const target = await fixture();
      for (const role of ["CASHIER", "FINANCE", "STOCK_MANAGEMENT", "PROCUREMENT"] as const) {
        const user = await fixture(role);
        await assert.rejects(resetUserPassword(db, { userId: user.id, credentialsVersion: 1 }, request(target.id)), { code: "FORBIDDEN" });
      }
      for (const invalid of [{ userId: randomUUID(), credentialsVersion: 1 }, { ...actor, credentialsVersion: 2 }]) await assert.rejects(resetUserPassword(db, invalid, request(target.id)), { code: "FORBIDDEN" });
      const inactive = await fixture("ADMIN", false);
      await assert.rejects(resetUserPassword(db, { userId: inactive.id, credentialsVersion: 1 }, request(target.id)), { code: "FORBIDDEN" });
      await assert.rejects(resetUserPassword(db, actor, { ...request(target.id), adminPassword: "wrong" }), { code: "REAUTHENTICATE" });
      cookie = undefined;
      await assert.rejects(resetPasswordAction(request(target.id)), redirects("/login"));
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: target.id } })).credentialsVersion, 1);
    });
    await t.test("self, ADMIN, inactive and missing targets are rejected without writes", async () => {
      const inactive = await fixture("CASHIER", false);
      for (const id of [admin.id, second.id, inactive.id, randomUUID()]) await assert.rejects(resetUserPassword(db, actor, request(id)), { code: "FORBIDDEN" });
    });
    await t.test("reset returns a unique secret once, expires in 30 minutes, and has immutable secret-free evidence", async () => {
      const target = await fixture(), other = await fixture();
      const input = request(target.id), start = Date.now();
      const first = await resetUserPassword(db, actor, input), another = await resetUserPassword(db, actor, request(other.id));
      assert.ok(first.temporaryPassword); assert.ok(another.temporaryPassword);
      assert.notEqual(first.temporaryPassword, another.temporaryPassword);
      const stored = await db.user.findUniqueOrThrow({ where: { id: target.id } });
      assert.equal(stored.credentialsVersion, 2); assert.equal(stored.mustChangePassword, true);
      assert.ok(stored.temporaryCredentialExpiresAt!.getTime() >= start + 1800000);
      assert.ok(stored.temporaryCredentialExpiresAt!.getTime() <= Date.now() + 1800000);
      assert.ok(await verifyPassword(stored.passwordHash, first.temporaryPassword));
      assert.equal(await verifyPassword(stored.passwordHash, password), false);
      const replay = await resetUserPassword(db, actor, input);
      assert.equal(replay.temporaryPassword, null); assert.equal(replay.replayed, true);
      assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: target.id } }), stored);
      assert.equal(await db.auditLog.count({ where: { id: input.operationId } }), 1);
      const audit = await db.auditLog.findUniqueOrThrow({ where: { id: input.operationId } });
      const evidence = JSON.stringify(audit);
      for (const secret of [password, first.temporaryPassword, stored.passwordHash]) assert.ok(!evidence.includes(secret));
      await assert.rejects(db.auditLog.update({ where: { id: input.operationId }, data: { action: "tampered" } }));
      await assert.rejects(db.auditLog.delete({ where: { id: input.operationId } }));
    });
    await t.test("lost-response status and explicit reissue invalidate the first credential; stale and changed intents reject", async () => {
      const target = await fixture(), input = request(target.id);
      const first = await resetUserPassword(db, actor, input);
      assert.equal((await readResetStatus(db, actor, target.id, input.operationId)).operation, "APPLIED");
      await assert.rejects(resetUserPassword(db, actor, { ...input, expectedVersion: 2 }), { code: "INTENT_CONFLICT" });
      await assert.rejects(resetUserPassword(db, actor, { ...input, userId: (await fixture()).id }), { code: "INTENT_CONFLICT" });
      await assert.rejects(resetUserPassword(db, { userId: second.id, credentialsVersion: 1 }, input), { code: "INTENT_CONFLICT" });
      await assert.rejects(resetUserPassword(db, actor, request(target.id)), { code: "STALE_VERSION" });
      // Reissue is a later operator action, after this scenario's five admissions.
      await db.authThrottle.updateMany({ data: { expiresAt: new Date(0) } });
      const issued = await resetUserPassword(db, actor, request(target.id, 2));
      assert.ok(issued.temporaryPassword);
      assert.equal((await readResetStatus(db, actor, target.id, input.operationId)).operation, "SUPERSEDED");
      assert.equal(await authenticateCredentials(target.loginIdentifier, first.temporaryPassword), null);
      assert.ok(await authenticateCredentials(target.loginIdentifier, issued.temporaryPassword));
      assert.equal((await resetUserPassword(db, actor, input)).temporaryPassword, null);
    });
    await t.test("concurrent identical resets produce one secret and concurrent new operations have one winner", async () => {
      const target = await fixture(), input = request(target.id);
      const same = await Promise.all([resetUserPassword(db, actor, input), resetUserPassword(db, actor, input)]);
      assert.equal(same.filter(result => result.temporaryPassword !== null).length, 1);
      const competing = await Promise.allSettled([resetUserPassword(db, actor, request(target.id, 2)), resetUserPassword(db, actor, request(target.id, 2))]);
      assert.equal(competing.filter(result => result.status === "fulfilled").length, 1);
      assert.equal((competing.find(result => result.status === "rejected") as PromiseRejectedResult).reason.code, "STALE_VERSION");
      assert.equal(await db.auditLog.count({ where: { entityId: target.id, action: "USER_PASSWORD_RESET" } }), 2);
    });
    await t.test("temporary login invalidates old JWT and every normal authorization guard requires change", async () => {
      const target = await fixture(); await session(target.id); const oldCookie = cookie;
      const reset = await resetUserPassword(db, actor, request(target.id));
      assert.equal(await getCurrentUser(), null);
      assert.deepEqual(await loginAction(target.loginIdentifier, reset.temporaryPassword), { success: true });
      const temporaryCookie = cookie;
      assert.notEqual(temporaryCookie, oldCookie);
      assert.equal((await getPasswordChangeUser())?.mustChangePassword, true);
      for (const guard of [getCurrentUser, requireOperator, requireInventoryManager, requireFinanceManager, requireProcurementReader, () => requireRole("ADMIN")]) await assert.rejects(guard(), redirects("/change-password"));
      const newPassword = randomBytes(24).toString("base64url");
      await assert.rejects(changePassword(db, { userId: target.id, credentialsVersion: 2 }, { newPassword: reset.temporaryPassword, confirmation: reset.temporaryPassword }), { code: "INVALID_INPUT" });
      assert.deepEqual(await changePasswordAction({ newPassword, confirmation: newPassword }), { success: true });
      assert.equal(cookie, ""); cookie = temporaryCookie;
      assert.equal(await getPasswordChangeUser(), null);
      assert.equal(await authenticateCredentials(target.loginIdentifier, reset.temporaryPassword), null);
      assert.ok(await authenticateCredentials(target.loginIdentifier, newPassword));
      const changed = await db.user.findUniqueOrThrow({ where: { id: target.id } });
      assert.equal(changed.credentialsVersion, 3); assert.equal(changed.mustChangePassword, false); assert.equal(changed.temporaryCredentialExpiresAt, null);
    });
    await t.test("expiry blocks temporary login and continuation of an already-issued restricted JWT", async () => {
      const target = await fixture(); const reset = await resetUserPassword(db, actor, request(target.id));
      await loginAction(target.loginIdentifier, reset.temporaryPassword);
      await db.user.update({ where: { id: target.id }, data: { temporaryCredentialExpiresAt: new Date(Date.now() - 1) } });
      assert.equal(await authenticateCredentials(target.loginIdentifier, reset.temporaryPassword), null);
      assert.equal(await getPasswordChangeUser(), null);
      const newPassword = randomBytes(24).toString("base64url");
      await assert.rejects(changePassword(db, { userId: target.id, credentialsVersion: 2 }, { newPassword, confirmation: newPassword }), { code: "EXPIRED" });
      assert.equal((await readResetStatus(db, actor, target.id)).state, "EXPIRED");
    });
    await t.test("voluntary ADMIN change requires current password and invalidates all previous sessions", async () => {
      const owner = await fixture("ADMIN"); await session(owner.id); const old = cookie;
      const next = randomBytes(24).toString("base64url"), identity = { userId: owner.id, credentialsVersion: 1 };
      await assert.rejects(changePassword(db, identity, { newPassword: next, confirmation: next, currentPassword: "wrong" }), { code: "REAUTHENTICATE" });
      await changePassword(db, identity, { newPassword: next, confirmation: next, currentPassword: password });
      cookie = old; assert.equal(await getCurrentUser(), null);
      assert.equal(await authenticateCredentials(owner.loginIdentifier, password), null);
      assert.ok(await authenticateCredentials(owner.loginIdentifier, next));
    });
    await t.test("deactivation increments once; reactivation cannot revive JWT; current roles remain authoritative", async () => {
      const target = await fixture(); await session(target.id); const old = cookie;
      await changeUserRole(db, admin, { userId: target.id, role: "FINANCE" });
      assert.equal((await getCurrentUser())?.role, "FINANCE");
      await setUserActive(db, admin, { userId: target.id, active: false });
      await setUserActive(db, admin, { userId: target.id, active: false });
      assert.equal(await getCurrentUser(), null);
      await setUserActive(db, admin, { userId: target.id, active: true });
      cookie = old; assert.equal(await getCurrentUser(), null);
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: target.id } })).credentialsVersion, 2);
      await loginAction(target.loginIdentifier, password); assert.equal((await getCurrentUser())?.role, "FINANCE");
      await logoutAction(); assert.equal(cookie, "");
    });
    await t.test("legacy short passwords still log in, but new hashing rejects them", async () => {
      const legacy = "old-short";
      const user = await fixture();
      await db.user.update({ where: { id: user.id }, data: { passwordHash: await require("@node-rs/argon2").hash(legacy) } });
      assert.ok(await authenticateCredentials(user.loginIdentifier, legacy));
      await assert.rejects(hashPassword(legacy));
    });
    await t.test("reset racing password verification can only issue the old, now-rejected version", async () => {
      const target = await fixture();
      const uniqueHash = await hashPassword(password); await db.user.update({ where: { id: target.id }, data: { passwordHash: uniqueHash } });
      const argon = require("@node-rs/argon2"), original = argon.verify;
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const spy = t.mock.method(argon, "verify", async (hash: string, value: string) => { if (hash === uniqueHash) { entered(); await gate; } return original(hash, value); });
      try {
        const login = loginAction(target.loginIdentifier, password); await ready;
        await resetUserPassword(db, actor, request(target.id)); release(); await login;
        assert.equal(await getCurrentUser(), null);
      } finally { release(); spy.mock.restore(); }
    });
    await t.test("audit failure rolls back hash, version, temporary state and receipt", async () => {
      const target = await fixture(), input = request(target.id);
      const broken = { user: db.user, $queryRaw: db.$queryRaw.bind(db), $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => db.$transaction(tx => fn(new Proxy(tx, { get(model, key) {
        return key === "auditLog" ? new Proxy(model.auditLog, { get(audit, method) { return method === "create" ? async () => { throw new Error("injected"); } : Reflect.get(audit, method); } }) : Reflect.get(model, key);
      } }))) } as unknown as PrismaClient;
      await assert.rejects(resetUserPassword(broken, actor, input), /injected/);
      assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: target.id } }), target);
      assert.equal(await db.auditLog.count({ where: { id: input.operationId } }), 0);
      const next = randomBytes(24).toString("base64url");
      await assert.rejects(changePassword(broken, { userId: target.id, credentialsVersion: 1 }, { newPassword: next, confirmation: next, currentPassword: password }), /injected/);
      assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: target.id } }), target);
    });
    await t.test("database rejects inconsistent recovery state and nonpositive versions", async () => {
      const target = await fixture();
      for (const data of [{ credentialsVersion: 0 }, { mustChangePassword: true }, { temporaryCredentialExpiresAt: new Date() }]) await assert.rejects(db.user.update({ where: { id: target.id }, data }));
    });
  } finally {
    t.mock.restoreAll(); if (previousNavigation) require.cache[navigationPath] = previousNavigation; else delete require.cache[navigationPath];
    if (originalSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = originalSecret;
    await prisma.$disconnect(); await db.$disconnect();
  }
});
