import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname, userInfo } from "node:os";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient, type UserRole } from "../src/generated/prisma/client";
import { recoveryIntent, recoveryTarget } from "../src/lib/auth/emergency-recovery/domain";
import { inspectRecovery, recoverAdmin } from "../src/lib/auth/emergency-recovery/service";
import { hashPassword, verifyPassword } from "../src/lib/auth/password";

test("emergency ADMIN recovery on positively identified isolated PostgreSQL", async t => {
  assert.notEqual(process.env.NODE_ENV, "production");
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/aroom_access_test_[a-f0-9]{32}$/);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  const second = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  const [identity] = await db.$queryRaw<{ database: string; user: string; sessionUser: string; schema: string; port: number; address: string }[]>`
    SELECT current_database() AS database, current_user AS "user", session_user AS "sessionUser",
      current_schema() AS schema, inet_server_port() AS port, host(inet_server_addr()) AS address`;
  assert.equal(identity.database, url.pathname.slice(1));
  assert.equal(identity.user, decodeURIComponent(url.username));
  const target = recoveryTarget({ RECOVERY_DATABASE_URL: url.toString(), RECOVERY_EXPECTED_HOST: url.hostname,
    RECOVERY_EXPECTED_PORT: url.port || "5432", RECOVERY_EXPECTED_DATABASE: identity.database,
    RECOVERY_EXPECTED_SCHEMA: "public", RECOVERY_EXPECTED_USER: identity.user, RECOVERY_EXPECTED_SERVER_ADDRESS: identity.address });
  const directory = new URL("./migrations/", import.meta.url);
  const migrations = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => ({ name: entry.name,
    checksum: createHash("sha256").update(readFileSync(new URL(`${entry.name}/migration.sql`, directory))).digest("hex") }));
  assert.equal(migrations.length, 21);
  const osUser = userInfo();
  const evidence = { osUsername: osUser.username, osUid: String(osUser.uid), hostname: hostname() };
  const previousPassword = randomBytes(24).toString("base64url"), sharedHash = await hashPassword(previousPassword);
  const fixture = (role: UserRole = "ADMIN", active = true) => db.user.create({ data: { name: "Emergency recovery fixture",
    loginIdentifier: randomUUID(), passwordHash: sharedHash, role, active } });
  const request = (targetUserId: string, expectedVersion = 1) => recoveryIntent({ targetUserId, expectedVersion, operationId: randomUUID(),
    approvalReference: "Owner-approved isolated emergency recovery test", operatorIdentity: "Independent test operator" });
  const credential = () => randomBytes(24).toString("base64url");
  const recover = (input: ReturnType<typeof request>, password = credential(), client = db) =>
    recoverAdmin(client, target, migrations, input, evidence, password, password);
  const transactionProxy = (override: (tx: Prisma.TransactionClient, key: string | symbol) => unknown) =>
    new Proxy(db, { get(client, key) {
      if (key === "$transaction") return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) =>
        db.$transaction(tx => work(new Proxy(tx, { get(model, method) { return override(model, method); } })), options);
      return Reflect.get(client, key);
    } });
  const require = createRequire(import.meta.url);
  const navigationPath = require.resolve("next/navigation"), previousNavigation = require.cache[navigationPath];
  require("next/dist/client/components/navigation.react-server");
  require.cache[navigationPath] = require.cache[require.resolve("next/dist/client/components/navigation.react-server")];
  const previousSessionSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = randomBytes(32).toString("base64");
  let cookie: string | undefined;
  t.mock.method(require("next/headers"), "cookies", async () => ({ get: () => cookie ? { value: cookie } : undefined }));
  const { prisma } = await import("../src/lib/db");
  const { getCurrentUser } = await import("../src/lib/auth/current-user");
  const { signSessionToken } = await import("../src/lib/auth/session-token");
  const { authenticateCredentials } = await import("../src/lib/auth/credentials");
  const unrelated = await fixture("CASHIER");
  const category = await db.category.create({ data: { name: `Recovery preservation ${randomUUID()}` } });
  await db.product.create({ data: { name: "Preserved menu item", categoryId: category.id, price: 22000 } });
  await db.ingredient.create({ data: { name: `Preserved ingredient ${randomUUID()}`, baseUnit: "g", currentStock: "17.125",
    weightedAverageUnitCostMicros: BigInt(2300000) } });
  await db.supplier.create({ data: { name: "Preserved recovery supplier", phone: "test-only" } });
  const finance = await fixture("FINANCE");
  await db.financeExpense.create({ data: { id: randomUUID(), occurredAt: new Date(), amount: 22000, category: "Lainnya",
    description: "Preserved finance expense", createdBy: finance.id } });
  const businessSnapshot = async () => {
    const result: Record<string, string[]> = {};
    for (const table of Object.values(Prisma.ModelName).filter(name => !["User", "EmergencyAdminRecovery", "AuthThrottle"].includes(name)).sort()) {
      const rows = await db.$queryRawUnsafe<{ row: unknown }[]>(`SELECT to_jsonb(t) AS row FROM public."${table}" t`);
      result[table] = rows.map(row => JSON.stringify(row.row)).sort();
    }
    return result;
  };
  const businessBefore = await businessSnapshot();
  try {
    await t.test("successful active ADMIN recovery verifies password, clears recovery state and records accurate external evidence", async () => {
      const admin = await fixture();
      await db.user.update({ where: { id: admin.id }, data: { mustChangePassword: true, temporaryCredentialExpiresAt: new Date(Date.now() + 60000) } });
      const input = request(admin.id), password = "  Private kopi \u00e9 senja \u{1f319} 98765  ";
      const [before] = await db.$queryRaw<{ milliseconds: number }[]>`SELECT
        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::double precision AS milliseconds`;
      const result = await recover(input, password);
      const [after] = await db.$queryRaw<{ milliseconds: number }[]>`SELECT
        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::double precision AS milliseconds`;
      assert.deepEqual(result, { operation: "APPLIED", targetUserId: admin.id, currentVersion: 2, resultingVersion: 2 });
      const stored = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
      assert.equal(stored.credentialsVersion, 2); assert.equal(stored.role, "ADMIN"); assert.equal(stored.active, true);
      assert.equal(stored.mustChangePassword, false); assert.equal(stored.temporaryCredentialExpiresAt, null);
      assert.match(stored.passwordHash, /^\$argon2id\$/);
      assert.ok(await verifyPassword(stored.passwordHash, password));
      assert.equal(await verifyPassword(stored.passwordHash, password.trim()), false);
      assert.equal(await verifyPassword(stored.passwordHash, password.normalize("NFD")), false);
      assert.equal(await verifyPassword(stored.passwordHash, previousPassword), false);
      // The installed adapter decodes timestamptz correctly with a UTC session.
      // Keep the database's original timezone elsewhere so recovery must set its
      // own transaction timezone instead of depending on the test environment.
      const receipt = await db.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
        return tx.emergencyAdminRecovery.findUniqueOrThrow({ where: { id: input.operationId } });
      });
      assert.equal(receipt.targetUserId, admin.id); assert.equal(receipt.expectedVersion, 1); assert.equal(receipt.resultingVersion, 2);
      assert.equal(receipt.approvalReference, input.approvalReference); assert.equal(receipt.operatorIdentity, input.operatorIdentity);
      assert.equal(receipt.osUsername, evidence.osUsername); assert.equal(receipt.osUid, evidence.osUid); assert.equal(receipt.hostname, evidence.hostname);
      assert.equal(receipt.databaseHost, target.host); assert.equal(receipt.databasePort, identity.port); assert.equal(receipt.databaseName, identity.database);
      assert.equal(receipt.databaseSchema, identity.schema); assert.equal(receipt.databaseUser, identity.user); assert.equal(receipt.databaseSessionUser, identity.sessionUser);
      assert.equal(receipt.databaseServerAddress, identity.address); assert.equal(receipt.intent, "REPLACE_EXISTING_ACTIVE_ADMIN_CREDENTIAL");
      const [rawTimestamp] = await db.$queryRaw<{ milliseconds: number }[]>`SELECT
        (EXTRACT(EPOCH FROM "createdAt") * 1000)::double precision AS milliseconds
        FROM public."EmergencyAdminRecovery" WHERE id = ${input.operationId}::uuid`;
      // The service captures PostgreSQL's clock inside the transaction; allow
      // the receipt column's millisecond storage precision at the boundaries.
      assert.equal(receipt.createdAt.getTime(), rawTimestamp.milliseconds);
      assert.ok(rawTimestamp.milliseconds >= before.milliseconds - 2 && rawTimestamp.milliseconds <= after.milliseconds + 2,
        `serverBeforeMs=${before.milliseconds} receiptMs=${receipt.createdAt.getTime()} serverAfterMs=${after.milliseconds} sqlReceiptMs=${rawTimestamp.milliseconds}`);
      const serialized = JSON.stringify(receipt);
      for (const secret of [password, previousPassword, stored.passwordHash, url.toString(), decodeURIComponent(url.password)].filter(Boolean)) assert.ok(!serialized.includes(secret));
      assert.doesNotMatch(serialized, /passwordHash|sessionToken|connectionString|fingerprint/);
      assert.equal(await db.auditLog.count({ where: { id: input.operationId } }), 0);
    });

    await t.test("non-ADMIN, inactive ADMIN and missing targets cannot be created, promoted or reactivated", async () => {
      for (const role of ["CASHIER", "FINANCE", "STOCK_MANAGEMENT", "PROCUREMENT"] as const) {
        const user = await fixture(role), input = request(user.id);
        await assert.rejects(recover(input), { code: "FORBIDDEN" });
        assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: user.id } }), user);
        assert.equal(await db.emergencyAdminRecovery.count({ where: { id: input.operationId } }), 0);
      }
      const inactive = await fixture("ADMIN", false);
      await assert.rejects(recover(request(inactive.id)), { code: "FORBIDDEN" });
      assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: inactive.id } }), inactive);
      const missing = request(randomUUID()), before = await db.user.count();
      await assert.rejects(recover(missing), { code: "FORBIDDEN" });
      assert.equal(await db.user.count(), before);
    });

    await t.test("verified runtime database, schema, port, server address and both principals are rechecked inside the transaction", async () => {
      const admin = await fixture(), input = request(admin.id);
      for (const patch of [{ database: "aroom_pos" }, { schema: "private" }, { port: identity.port + 1 },
        { address: "192.0.2.77" }, { user: "other_principal" }, { sessionUser: "other_session_principal" }]) {
        const mismatched = transactionProxy((tx, key) => key === "$queryRaw" ? async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const result = await tx.$queryRaw(strings, ...values);
          return strings.join("").includes("current_database()") ? [{ ...(result as object[])[0], ...patch }] : result;
        } : Reflect.get(tx, key));
        await assert.rejects(recover(input, credential(), mismatched), { code: "IDENTITY_MISMATCH" });
      }
      assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: admin.id } }), admin);
      assert.equal(await db.emergencyAdminRecovery.count({ where: { id: input.operationId } }), 0);
    });

    await t.test("incorrect or incomplete migration manifests reject both recovery and safe inspection", async () => {
      const admin = await fixture(), input = request(admin.id), password = credential();
      for (const invalid of [[], migrations.slice(1), [...migrations, migrations[0]],
        migrations.map((migration, index) => index ? migration : { ...migration, checksum: "0".repeat(64) })]) {
        await assert.rejects(recoverAdmin(db, target, invalid, input, evidence, password, password), { code: "MIGRATIONS_REQUIRED" });
        await assert.rejects(inspectRecovery(db, target, invalid, input, evidence), { code: "MIGRATIONS_REQUIRED" });
      }
      assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: admin.id } }), admin);
    });

    await t.test("uncompleted, rolled-back or checksum-altered database migration records reject recovery and are restored", async () => {
      const admin = await fixture(), input = request(admin.id);
      const name = "20261016000000_emergency_admin_recovery";
      const [row] = await db.$queryRaw<{ checksum: string; finished_at: Date; rolled_back_at: Date | null }[]>`
        SELECT checksum, finished_at, rolled_back_at FROM public."_prisma_migrations" WHERE migration_name = ${name}`;
      try {
        await db.$executeRaw`UPDATE public."_prisma_migrations" SET finished_at = NULL WHERE migration_name = ${name}`;
        await assert.rejects(recover(input), { code: "MIGRATIONS_REQUIRED" });
        await db.$executeRaw`UPDATE public."_prisma_migrations" SET finished_at = ${row.finished_at}, rolled_back_at = CURRENT_TIMESTAMP WHERE migration_name = ${name}`;
        await assert.rejects(recover(input), { code: "MIGRATIONS_REQUIRED" });
        await db.$executeRaw`UPDATE public."_prisma_migrations" SET rolled_back_at = ${row.rolled_back_at}, checksum = ${"0".repeat(64)} WHERE migration_name = ${name}`;
        await assert.rejects(recover(input), { code: "MIGRATIONS_REQUIRED" });
      } finally {
        await db.$executeRaw`UPDATE public."_prisma_migrations" SET checksum = ${row.checksum}, finished_at = ${row.finished_at}, rolled_back_at = ${row.rolled_back_at} WHERE migration_name = ${name}`;
      }
      assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: admin.id } }), admin);
    });

    await t.test("new recovery requires the expected current version and rejects weak, mismatched or common credentials without mutation", async () => {
      const admin = await fixture(), input = request(admin.id);
      await assert.rejects(recover(request(admin.id, 2)), { code: "STALE_VERSION" });
      for (const password of ["short", " ".repeat(30), "a".repeat(129)]) await assert.rejects(recover(input, password), { code: "INVALID_INPUT" });
      await assert.rejects(recoverAdmin(db, target, migrations, input, evidence, credential(), "different"), { code: "INVALID_INPUT" });
      // Local corpus entries are checked through the same hashing boundary as every new credential.
      const rows = readFileSync(new URL("../src/lib/auth/password-blocklist.txt", import.meta.url), "utf8").split(/\r?\n/);
      const common = rows.find(value => Array.from(value).length >= 20 && Array.from(value).length <= 128 && value.trim());
      assert.ok(common, "Pinned corpus must include a recovery-policy-length candidate for this test");
      await assert.rejects(recover(input, common), { code: "COMMON_PASSWORD" });
      assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: admin.id } }), admin);
      assert.equal(await db.emergencyAdminRecovery.count({ where: { id: input.operationId } }), 0);
    });

    await t.test("concurrent distinct operations at the same version have one winner and one stale loser", async () => {
      const admin = await fixture(), first = request(admin.id), other = request(admin.id);
      const results = await Promise.allSettled([recover(first), recover(other, credential(), second)]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      assert.equal((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason.code, "STALE_VERSION");
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: admin.id } })).credentialsVersion, 2);
      assert.equal(await db.emergencyAdminRecovery.count({ where: { targetUserId: admin.id } }), 1);
    });

    await t.test("concurrent identical operations and repeated replay never rehash, reapply, increment or duplicate receipts", async () => {
      const admin = await fixture(), input = request(admin.id), password = credential();
      const results = await Promise.all([recover(input, password), recover(input, password, second)]);
      assert.ok(results.every(result => result.operation === "APPLIED"));
      const after = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
      assert.equal(after.credentialsVersion, 2);
      for (const supplied of [undefined, "bad", "".padEnd(129, "a")]) {
        assert.deepEqual(await recoverAdmin(db, target, migrations, input, evidence, supplied, "different"), results[0]);
        assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: admin.id } }), after);
      }
      assert.equal(await db.emergencyAdminRecovery.count({ where: { id: input.operationId } }), 1);
      assert.ok(await verifyPassword(after.passwordHash, password));
    });

    await t.test("UUID replay is bound to target, version, approval, operator and verified host evidence", async () => {
      const admin = await fixture(), input = request(admin.id);
      await recover(input);
      const after = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
      for (const patch of [{ targetUserId: (await fixture()).id }, { expectedVersion: 2 },
        { approvalReference: "Another approval" }, { operatorIdentity: "Another operator" }]) {
        await assert.rejects(recoverAdmin(db, target, migrations, { ...input, ...patch }, evidence), { code: "INTENT_CONFLICT" });
        await assert.rejects(inspectRecovery(db, target, migrations, { ...input, ...patch }, evidence), { code: "INTENT_CONFLICT" });
      }
      for (const patch of [{ osUsername: evidence.osUsername + "changed" }, { osUid: evidence.osUid + "changed" }, { hostname: evidence.hostname + "changed" }]) {
        await assert.rejects(recoverAdmin(db, target, migrations, input, { ...evidence, ...patch }), { code: "INTENT_CONFLICT" });
      }
      const aliasUrl = new URL(url); aliasUrl.hostname = url.hostname === "localhost" ? "127.0.0.1" : "localhost";
      await assert.rejects(recoverAdmin(db, { ...target, connectionString: aliasUrl.toString(), host: aliasUrl.hostname }, migrations, input, evidence), { code: "INTENT_CONFLICT" });
      assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: admin.id } }), after);
    });

    await t.test("lost responses are inspected safely and a separately approved new UUID supersedes the old receipt", async () => {
      const admin = await fixture(), input = request(admin.id), firstPassword = credential();
      assert.deepEqual(await inspectRecovery(db, target, migrations, input, evidence), {
        operation: "NOT_FOUND", targetUserId: admin.id, currentVersion: 1, resultingVersion: null });
      await recover(input, firstPassword); // The caller intentionally discards the write response.
      assert.deepEqual(await inspectRecovery(db, target, migrations, input, evidence), {
        operation: "APPLIED", targetUserId: admin.id, currentVersion: 2, resultingVersion: 2 });
      const newPassword = credential(); await recover(request(admin.id, 2), newPassword);
      const oldStatus = { operation: "SUPERSEDED", targetUserId: admin.id, currentVersion: 3, resultingVersion: 2 };
      assert.deepEqual(await inspectRecovery(db, target, migrations, input, evidence), oldStatus);
      assert.deepEqual(await recoverAdmin(db, target, migrations, input, evidence), oldStatus);
      const after = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
      assert.equal(after.credentialsVersion, 3); assert.equal(await verifyPassword(after.passwordHash, firstPassword), false);
      assert.ok(await verifyPassword(after.passwordHash, newPassword));
      assert.equal(await db.emergencyAdminRecovery.count({ where: { targetUserId: admin.id } }), 2);
    });

    await t.test("a committed receipt remains inspectable after later deactivation or demotion while new recovery is forbidden", async () => {
      for (const change of [{ active: false, credentialsVersion: { increment: 1 } }, { role: "CASHIER" as const }]) {
        const admin = await fixture(), input = request(admin.id); await recover(input);
        const changed = await db.user.update({ where: { id: admin.id }, data: change });
        const expected = { operation: changed.credentialsVersion === 2 ? "APPLIED" : "SUPERSEDED", targetUserId: admin.id,
          currentVersion: changed.credentialsVersion, resultingVersion: 2 };
        assert.deepEqual(await inspectRecovery(db, target, migrations, input, evidence), expected);
        assert.deepEqual(await recoverAdmin(db, target, migrations, input, evidence), expected);
        await assert.rejects(recover(request(admin.id, changed.credentialsVersion)), { code: "FORBIDDEN" });
        assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: admin.id } }), changed);
        assert.equal(await db.emergencyAdminRecovery.count({ where: { targetUserId: admin.id } }), 1);
      }
    });

    await t.test("receipt insert failure rolls back password, version, temporary state and receipt together", async () => {
      const admin = await fixture();
      const before = await db.user.update({ where: { id: admin.id }, data: { mustChangePassword: true,
        temporaryCredentialExpiresAt: new Date(Date.now() + 60000) } });
      const input = request(admin.id);
      const broken = transactionProxy((tx, key) => key === "emergencyAdminRecovery" ? new Proxy(tx.emergencyAdminRecovery, {
        get(model, method) { return method === "create" ? async () => { throw new Error("injected recovery receipt insert failure"); } : Reflect.get(model, method); },
      }) : Reflect.get(tx, key));
      await assert.rejects(recover(input, credential(), broken), /injected recovery receipt insert failure/);
      assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: admin.id } }), before);
      assert.equal(await db.emergencyAdminRecovery.count({ where: { id: input.operationId } }), 0);
      assert.equal((await inspectRecovery(db, target, migrations, input, evidence)).operation, "NOT_FOUND");
    });

    await t.test("credential write failure creates no receipt and a later permitted retry can apply", async () => {
      const admin = await fixture(), input = request(admin.id);
      const broken = transactionProxy((tx, key) => key === "user" ? new Proxy(tx.user, {
        get(model, method) { return method === "update" ? async () => { throw new Error("injected credential write failure"); } : Reflect.get(model, method); },
      }) : Reflect.get(tx, key));
      await assert.rejects(recover(input, credential(), broken), /injected credential write failure/);
      assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: admin.id } }), admin);
      assert.equal(await db.emergencyAdminRecovery.count({ where: { id: input.operationId } }), 0);
      assert.equal((await recover(input)).operation, "APPLIED");
    });

    await t.test("the shared access-management advisory lock delays recovery until fresh role/status checks", async () => {
      const admin = await fixture(), input = request(admin.id);
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const competing = second.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(183621, 1)`;
        entered(); await gate;
        await tx.user.update({ where: { id: admin.id }, data: { active: false, credentialsVersion: { increment: 1 } } });
      });
      await ready;
      const pending = recover(input);
      try {
        let waiting = false;
        for (let attempt = 0; attempt < 40; attempt++) {
          const [state] = await db.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'
              AND query LIKE '%pg_advisory_xact_lock%') AS waiting`;
          if (state.waiting) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(waiting, "Recovery must wait on the existing access-management advisory lock");
      } finally { release(); }
      await competing;
      await assert.rejects(pending, { code: "FORBIDDEN" });
      const after = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
      assert.equal(after.active, false); assert.equal(after.passwordHash, admin.passwordHash); assert.equal(after.credentialsVersion, 2);
      assert.equal(await db.emergencyAdminRecovery.count({ where: { id: input.operationId } }), 0);
    });

    await t.test("old signed sessions fail subsequent real authentication reads and fresh login remains compatible", async () => {
      const admin = await fixture(), input = request(admin.id), password = credential();
      cookie = await signSessionToken({ userId: admin.id, credentialsVersion: 1 });
      assert.equal((await getCurrentUser())?.id, admin.id);
      await recover(input, password);
      assert.equal(await getCurrentUser(), null);
      assert.equal(await authenticateCredentials(admin.loginIdentifier, previousPassword), null);
      const fresh = await authenticateCredentials(admin.loginIdentifier, password);
      assert.equal(fresh?.id, admin.id); assert.equal(fresh?.credentialsVersion, 2);
      cookie = await signSessionToken({ userId: admin.id, credentialsVersion: 2 });
      assert.equal((await getCurrentUser())?.id, admin.id);
    });

    await t.test("PostgreSQL rejects receipt UPDATE, DELETE and TRUNCATE and preserves the external receipt", async () => {
      const admin = await fixture(), input = request(admin.id); await recover(input);
      const receipt = await db.emergencyAdminRecovery.findUniqueOrThrow({ where: { id: input.operationId } });
      await assert.rejects(db.emergencyAdminRecovery.update({ where: { id: input.operationId }, data: { operatorIdentity: "forged" } }));
      await assert.rejects(db.emergencyAdminRecovery.delete({ where: { id: input.operationId } }));
      await assert.rejects(db.$executeRaw`TRUNCATE TABLE public."EmergencyAdminRecovery"`);
      assert.deepEqual(await db.emergencyAdminRecovery.findUniqueOrThrow({ where: { id: input.operationId } }), receipt);
      await assert.rejects(db.user.delete({ where: { id: admin.id } }));
      // The predefined role has ordinary UPDATE/DELETE access without owning the
      // table. SET LOCAL leaves no persistent role, grant or authorization change.
      const [principal] = await db.$queryRaw<{ allowed: boolean }[]>`SELECT rolsuper OR
        pg_has_role(current_user, 'pg_write_all_data', 'MEMBER') AS allowed FROM pg_roles WHERE rolname = current_user`;
      if (principal.allowed) {
        for (const operation of ["UPDATE", "DELETE"] as const) await assert.rejects(db.$transaction(async tx => {
          await tx.$executeRaw`SET LOCAL ROLE pg_write_all_data`;
          if (operation === "UPDATE") await tx.$executeRaw`UPDATE public."EmergencyAdminRecovery" SET "operatorIdentity" = 'forged'`;
          else await tx.$executeRaw`DELETE FROM public."EmergencyAdminRecovery"`;
        }), /immutable/);
      }
    });

    await t.test("database constraints enforce receipt integrity without weakening existing credential audit protections", async () => {
      const admin = await fixture(), input = request(admin.id); await recover(input);
      const receipt = await db.emergencyAdminRecovery.findUniqueOrThrow({ where: { id: input.operationId } });
      for (const patch of [{ expectedVersion: 0 }, { resultingVersion: receipt.expectedVersion + 2 }, { approvalReference: "" },
        { operatorIdentity: " " }, { osUsername: "" }, { hostname: " " }, { databasePort: 0 }, { databaseSchema: "private" },
        { databaseUser: "" }, { databaseSessionUser: "" }, { databaseServerAddress: "" }, { intent: "CREATE_ADMIN" },
        { targetUserId: randomUUID() }, { approvalReference: "a".repeat(257) }]) {
        await assert.rejects(db.emergencyAdminRecovery.create({ data: { ...receipt, id: randomUUID(), ...patch } }));
      }
      await assert.rejects(db.emergencyAdminRecovery.create({ data: receipt }));
      const audit = await db.auditLog.create({ data: { id: randomUUID(), actorId: admin.id, action: "USER_PASSWORD_CHANGED",
        entityType: "CredentialRecovery", entityId: admin.id, details: { expectedVersion: 1, resultingVersion: 2 } } });
      await assert.rejects(db.auditLog.update({ where: { id: audit.id }, data: { actorId: unrelated.id } }));
      await assert.rejects(db.auditLog.delete({ where: { id: audit.id } }));
      // Remove this sole test-created AuditLog from the preservation comparison;
      // its immutable value is verified separately and remains until disposal.
      businessBefore.AuditLog.push(JSON.stringify((await db.$queryRaw<{ row: unknown }[]>`
        SELECT to_jsonb(t) AS row FROM public."AuditLog" t WHERE id = ${audit.id}::uuid`)[0].row));
      businessBefore.AuditLog.sort();
    });

    await t.test("recovery has no secret-bearing logs and preserves all unrelated users and business records", async () => {
      const admin = await fixture(), input = request(admin.id), password = credential(), messages: string[] = [];
      const throttleBefore = await db.authThrottle.findMany({ orderBy: [{ scope: "asc" }, { key: "asc" }] });
      const otherUsersBefore = await db.user.findMany({ where: { id: { not: admin.id } }, orderBy: { id: "asc" } });
      const log = t.mock.method(console, "log", (...values: unknown[]) => { messages.push(values.map(String).join(" ")); });
      const error = t.mock.method(console, "error", (...values: unknown[]) => { messages.push(values.map(String).join(" ")); });
      const warn = t.mock.method(console, "warn", (...values: unknown[]) => { messages.push(values.map(String).join(" ")); });
      try { await recover(input, password); } finally { log.mock.restore(); error.mock.restore(); warn.mock.restore(); }
      const stored = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
      const output = messages.join("\n");
      for (const secret of [password, previousPassword, stored.passwordHash, url.toString()].filter(Boolean)) assert.ok(!output.includes(secret));
      assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: unrelated.id } }), unrelated);
      assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: finance.id } }), finance);
      assert.deepEqual(await db.user.findMany({ where: { id: { not: admin.id } }, orderBy: { id: "asc" } }), otherUsersBefore);
      assert.deepEqual(await db.authThrottle.findMany({ orderBy: [{ scope: "asc" }, { key: "asc" }] }), throttleBefore);
      assert.deepEqual(await businessSnapshot(), businessBefore);
    });
  } finally {
    t.mock.restoreAll();
    if (previousNavigation) require.cache[navigationPath] = previousNavigation; else delete require.cache[navigationPath];
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previousSessionSecret;
    await prisma.$disconnect(); await db.$disconnect(); await second.$disconnect();
  }
});
