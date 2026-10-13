import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../src/generated/prisma/client";
import { bootstrapAdmin } from "../src/lib/bootstrap/service";
import { bootstrapInput, bootstrapTarget } from "../src/lib/bootstrap/domain";
import { verifyPassword } from "../src/lib/auth/password";

test("first ADMIN bootstrap on a positively identified empty disposable database", async t => {
  assert.notEqual(process.env.NODE_ENV, "production");
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/aroom_bootstrap_test_[a-f0-9]{32}$/);
  const target = bootstrapTarget({ BOOTSTRAP_DATABASE_URL: url.toString(), BOOTSTRAP_EXPECTED_HOST: url.hostname,
    BOOTSTRAP_EXPECTED_PORT: url.port || "5432", BOOTSTRAP_EXPECTED_DATABASE: url.pathname.slice(1), BOOTSTRAP_EXPECTED_USER: decodeURIComponent(url.username) });
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  const directory = new URL("./migrations/", import.meta.url);
  const migrations = readdirSync(directory, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => ({ name: e.name,
    checksum: createHash("sha256").update(readFileSync(new URL(`${e.name}/migration.sql`, directory))).digest("hex") }));
  const password = randomBytes(32).toString("base64");
  const input = bootstrapInput("Owner", " OWNER ", password, password);
  try {
    assert.equal(await db.user.count(), 0);
    await t.test("wrong identity, incomplete migrations and weak password leave no account", async () => {
      await assert.rejects(bootstrapAdmin(db, { ...target, database: "aroom_pos" }, migrations, input), { code: "INVALID_TARGET" });
      await assert.rejects(bootstrapAdmin(db, { ...target, user: "wrong" }, migrations, input), { code: "IDENTITY_MISMATCH" });
      await assert.rejects(bootstrapAdmin(db, { ...target, database: "aroom_pos_operational_wrong" }, migrations, input), { code: "IDENTITY_MISMATCH" });
      await assert.rejects(bootstrapAdmin(db, target, migrations.slice(1), input), { code: "MIGRATIONS_REQUIRED" });
      await assert.rejects(bootstrapAdmin(db, target, migrations.map(m => ({ ...m, checksum: "wrong" })), input), { code: "MIGRATIONS_REQUIRED" });
      await assert.rejects(bootstrapAdmin(db, target, migrations, { ...input, password: "weak" }), { code: "INVALID_INPUT" });
      assert.equal(await db.user.count(), 0); assert.equal(await db.auditLog.count(), 0);
    });
    await t.test("non-user application data rejects initialization", async () => {
      const category = await db.category.create({ data: { name: "Existing master" } });
      await assert.rejects(bootstrapAdmin(db, target, migrations, input), { code: "DATABASE_NOT_EMPTY" });
      assert.equal(await db.user.count(), 0);
      await db.category.delete({ where: { id: category.id } });
    });
    await t.test("audit failure rolls back ADMIN creation", async () => {
      const broken = { $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => db.$transaction(tx => fn(new Proxy(tx, {
        get(target, key) { return key === "auditLog" ? { create: async () => { throw new Error("injected audit failure"); } } : Reflect.get(target, key); },
      }))) } as unknown as PrismaClient;
      await assert.rejects(bootstrapAdmin(broken, target, migrations, input), /injected audit failure/);
      assert.equal(await db.user.count(), 0); assert.equal(await db.auditLog.count(), 0);
    });
    await t.test("unexpected public tables reject initialization without altering their contents", async () => {
      await db.$executeRawUnsafe('CREATE TABLE public.bootstrap_extra_fixture (value integer)');
      try {
        await assert.rejects(bootstrapAdmin(db, target, migrations, input), { code: "DATABASE_NOT_EMPTY" });
        assert.equal(await db.user.count(), 0);
      } finally { await db.$executeRawUnsafe('DROP TABLE public.bootstrap_extra_fixture'); }
    });
    await t.test("concurrent attempts create exactly one ADMIN and one credential-free audit", async () => {
      const results = await Promise.allSettled([bootstrapAdmin(db, target, migrations, input), bootstrapAdmin(db, target, migrations, input)]);
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      const rejected = results.find(r => r.status === "rejected") as PromiseRejectedResult;
      assert.equal(rejected.reason.code, "DATABASE_NOT_EMPTY");
      const user = await db.user.findUniqueOrThrow({ where: { loginIdentifier: "owner" } });
      assert.equal(user.role, "ADMIN"); assert.equal(user.active, true); assert.match(user.passwordHash, /^\$argon2id\$/);
      assert.ok(await verifyPassword(user.passwordHash, password));
      const audit = await db.auditLog.findMany();
      assert.equal(audit.length, 1); assert.equal(audit[0].actorId, user.id); assert.equal(audit[0].entityId, user.id);
      assert.doesNotMatch(JSON.stringify(audit), /password|argon2|connectionString/);
      for (const model of [db.category, db.product, db.ingredient, db.supplier, db.order, db.shift, db.stockIn, db.financeExpense, db.procurement, db.inventoryPurchaseOrder]) {
        assert.equal(await (model.count as () => Promise<number>)(), 0);
      }
      await assert.rejects(bootstrapAdmin(db, target, migrations, input), { code: "DATABASE_NOT_EMPTY" });
    });
    await t.test("bootstrapped account authenticates through the production credential verifier", async () => {
      const { authenticateCredentials } = await import("../src/lib/auth/credentials");
      const { prisma } = await import("../src/lib/db");
      try {
        const user = await authenticateCredentials(" OWNER ", password);
        assert.equal(user?.role, "ADMIN"); assert.equal(user?.loginIdentifier, "owner");
        assert.ok(!JSON.stringify(user).includes("passwordHash"));
        assert.equal(await authenticateCredentials("owner", "incorrect"), null);
      } finally { await prisma.$disconnect(); }
    });
  } finally { await db.$disconnect(); }
});
