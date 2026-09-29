import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

// Isolated local database: never close or remove a real register shift for tests.
async function main() {
assert.notEqual(process.env.NODE_ENV, "production");
assert.ok(process.env.DATABASE_URL);
const url = new URL(process.env.DATABASE_URL);
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
const name = `aroom_report_test_${randomUUID().replaceAll("-", "")}`;
const control = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
url.pathname = `/${name}`;
const env = { ...process.env, DATABASE_URL: url.toString() };
const run = (args: string[]) => {
  const child = spawnSync(process.execPath, args, { env, stdio: "inherit" });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, `Command failed: ${args.join(" ")}`);
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
  run(["node_modules/tsx/dist/cli.mjs", "--conditions=react-server", "--test", "--test-concurrency=1",
    "prisma/transaction-adjustments.test.ts", "src/lib/reports/adjustment-domain.test.ts",
    "src/lib/reports/service.test.ts", "src/app/admin/reports/daily-report.test.ts",
    "src/lib/orders/receipt.test.ts", "src/lib/orders/service.test.ts",
    "src/lib/shifts/settlement.test.ts"]);
} finally {
  try { if (created) await control.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`); }
  finally { await control.$disconnect(); }
}
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
