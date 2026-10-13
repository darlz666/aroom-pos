import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

async function main() {
  assert.notEqual(process.env.NODE_ENV, "production");
  const focused = process.argv.includes("--focused");
  assert.ok(process.argv.slice(2).every(arg => arg === "--focused"));
  const base = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(base.hostname));
  base.pathname = "/postgres"; // Never connect to the configured application database.
  const control = new PrismaClient({ adapter: new PrismaPg({ connectionString: base.toString() }) });
  const logs = join(tmpdir(), `aroom-phase4b-${randomUUID()}`); mkdirSync(logs);
  console.log(`Evidence: ${logs}`);
  const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const protectedFiles = [".env", "next.config.ts", ".git/index"];
  const before = protectedFiles.map(hash);
  const files = ["src", "prisma"].flatMap(dir => readdirSync(dir, { recursive: true })
    .filter(file => typeof file === "string" && file.endsWith(".test.ts")).map(file => join(dir, String(file)).replaceAll("\\", "/")))
    .filter(file => !focused || /bootstrap|categories/.test(file)).sort();
  const migrationCount = readdirSync("prisma/migrations", { withFileTypes: true }).filter(e => e.isDirectory()).length;
  const results: { file: string; exit: number | null; tests: number; pass: number; fail: number; skipped: number; cancelled: number }[] = [];
  const created: string[] = [];
  const run = (file: string, args: string[], env: NodeJS.ProcessEnv) => new Promise<number | null>((resolve, reject) => {
    let output = "";
    const child = spawn(process.execPath, args, { env, windowsHide: true, detached: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { output += value; });
    child.once("error", reject);
    child.once("close", exit => {
      writeFileSync(join(logs, file.replaceAll("/", "_") + ".log"), output.replace(/postgres(?:ql)?:\/\/\S+/g, "[redacted database URL]"));
      const count = (key: string) => Number(output.match(new RegExp(`^# ${key} (\\d+)`, "m"))?.[1] ?? 0);
      const result = { file, exit, tests: count("tests"), pass: count("pass"), fail: count("fail"), skipped: count("skipped"), cancelled: count("cancelled") };
      results.push(result); console.log(JSON.stringify(result)); resolve(exit);
    });
  });
  try {
    for (const family of ["bootstrap", "access", "report"] as const) {
      const selected = files.filter(file => family === "bootstrap" ? file === "prisma/bootstrap-admin.test.ts" :
        family === "report" ? ["prisma/finance.test.ts", "prisma/procurement.test.ts"].includes(file) :
          !["prisma/bootstrap-admin.test.ts", "prisma/finance.test.ts", "prisma/procurement.test.ts"].includes(file));
      if (!selected.length) continue;
      const name = `aroom_${family}_test_${randomUUID().replaceAll("-", "")}`;
      assert.match(name, /^aroom_(bootstrap|access|report)_test_[a-f0-9]{32}$/);
      await control.$executeRawUnsafe(`CREATE DATABASE "${name}"`); created.push(name);
      const url = new URL(base); url.pathname = `/${name}`;
      const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url.toString(), NODE_ENV: "test", TSX_DISABLE_CACHE: "1" };
      console.log(`Created disposable ${name}`);
      assert.equal(await run(`${family}-migrate`, ["node_modules/prisma/build/index.js", "migrate", "deploy"], env), 0);
      const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
      try {
        const [identity] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`; assert.equal(identity.name, name);
        const [applied] = await db.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
        assert.equal(applied.count, migrationCount); assert.equal(await db.user.count(), 0);
        console.log(`Verified identity and ${migrationCount}/${migrationCount} migrations: ${name}`);
        if (family !== "bootstrap") for (const role of ["ADMIN", "CASHIER"] as const) await db.user.create({ data: { name: role, role, loginIdentifier: randomUUID(), passwordHash: "test-only-unused" } });
      } finally { await db.$disconnect(); }
      for (const file of selected) {
        const dom = file.startsWith("src/app/") && !file.endsWith("pos-e2e.test.ts");
        await run(file, ["--import", "tsx", ...(dom ? [] : ["--conditions=react-server"]), "--test", "--test-reporter=tap", "--test-concurrency=1", file], env);
      }
    }
  } finally {
    try {
      for (const name of created) {
        assert.match(name, /^aroom_(bootstrap|access|report)_test_[a-f0-9]{32}$/);
        await control.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
        const [row] = await control.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_database WHERE datname = ${name}`;
        assert.equal(row.count, 0); console.log(`Cleanup verified: ${name}`);
      }
    } finally { await control.$disconnect(); }
    writeFileSync(join(logs, "results.json"), JSON.stringify(results, null, 2));
    assert.deepEqual(protectedFiles.map(hash), before); console.log("Protected files and Git index unchanged.");
  }
  assert.equal(results.filter(r => r.file.endsWith(".test.ts")).length, files.length);
  const totals = results.reduce((sum, r) => ({ tests: sum.tests + r.tests, pass: sum.pass + r.pass, fail: sum.fail + r.fail,
    skipped: sum.skipped + r.skipped, cancelled: sum.cancelled + r.cancelled }), { tests: 0, pass: 0, fail: 0, skipped: 0, cancelled: 0 });
  console.log(JSON.stringify({ files: files.length, ...totals }));
  assert.ok(results.every(r => r.exit === 0 && !r.fail && !r.skipped && !r.cancelled), "Test failures: inspect evidence logs");
}
void main().catch(() => { console.error("Phase 4B verification failed; inspect the redacted per-file logs and cleanup output."); process.exitCode = 1; });
