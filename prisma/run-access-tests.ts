import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

// Run Access Management and all existing regressions in a disposable local DB.
async function main() {
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.ok(process.env.DATABASE_URL);
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  const name = `aroom_access_test_${randomUUID().replaceAll("-", "")}`;
  const control = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  url.pathname = `/${name}`;
  const env = { ...process.env, DATABASE_URL: url.toString() };
  const run = (args: string[]) => {
    const child = spawnSync(process.execPath, args, { env, stdio: "inherit" });
    if (child.error) throw child.error;
    assert.equal(child.status, 0, "Test command failed");
  };
  let created = false;
  try {
    await control.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    created = true;
    run(["node_modules/prisma/build/index.js", "migrate", "deploy"]);
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
    try {
      for (const role of ["ADMIN", "CASHIER"] as const) await db.user.create({ data: {
        name: "Isolated test user", loginIdentifier: randomUUID(), passwordHash: "unused", role,
      } });
    } finally { await db.$disconnect(); }
    const files = ["src", "prisma"].flatMap(dir => readdirSync(dir, { recursive: true })
      .filter((file): file is string => typeof file === "string" && file.endsWith(".test.ts"))
      .map(file => join(dir, file))).sort();
    // React DOM rendering tests require normal React exports; server-only tests
    // require the react-server condition. Keep both groups in the same database.
    const dom = files.filter(file => readFileSync(file, "utf8").includes('from "react-dom/server"'));
    run(["node_modules/tsx/dist/cli.mjs", "--conditions=react-server", "--test", "--test-concurrency=1", ...files.filter(file => !dom.includes(file))]);
    run(["node_modules/tsx/dist/cli.mjs", "--test", "--test-concurrency=1", ...dom]);
  } finally {
    try { if (created) await control.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`); }
    finally { await control.$disconnect(); }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
