import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

// Keep the existing inventory suites' access-test naming guard. Never migrate,
// seed or write fixtures to the configured operational database.
async function main() {
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.ok(process.env.DATABASE_URL);
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  const name = `aroom_access_test_${randomUUID().replaceAll("-", "")}`;
  const controlUrl = new URL(url);
  controlUrl.pathname = "/postgres";
  const control = new PrismaClient({ adapter: new PrismaPg({ connectionString: controlUrl.toString() }) });
  url.pathname = `/${name}`;
  const env = { ...process.env, DATABASE_URL: url.toString() };
  const run = (args: string[]) => new Promise<void>((resolve, reject) => {
    // Separate Windows console groups prevent a child runner's termination from
    // interrupting its parent before the disposable database is cleaned up.
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true, detached: process.platform === "win32" });
    child.stdout.on("data", chunk => process.stdout.write(chunk));
    child.stderr.on("data", chunk => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Inventory command failed: exit=${code}, signal=${signal}`));
    });
  });
  let created = false;
  try {
    await control.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    created = true;
    await run(["node_modules/prisma/build/index.js", "migrate", "deploy"]);
    const groups: Record<string, string[]> = {
      units: ["src/lib/inventory/domain.test.ts", "src/lib/inventory/unit-safety.test.ts", "src/lib/inventory/stock-in-domain.test.ts",
        "src/lib/inventory/receiving-form.test.ts", "src/lib/inventory/recipe-domain.test.ts", "src/lib/inventory/sale-domain.test.ts", "src/lib/inventory/dashboard-service.test.ts"],
      foundation: ["prisma/inventory-foundation.test.ts"],
      receiving: ["prisma/stock-in.test.ts"],
      costing: ["src/lib/inventory/costing.test.ts", "prisma/ingredient-costing.test.ts", "prisma/ingredient-costing-migration.test.ts"],
      sales: ["prisma/pos-stock-deduction.test.ts"],
      authorization: ["src/lib/auth/access.test.ts", "src/lib/inventory/actions.test.ts", "src/lib/inventory/recipe-actions.test.ts"],
      helper: ["prisma/stock-in-posting.test.ts"],
      migration: ["prisma/inventory-unit-safety.test.ts"],
      ui: ["src/app/inventory/inventory-ui.test.ts"],
      purchaseOrders: ["src/lib/inventory-purchase-orders/domain.test.ts", "src/lib/inventory-purchase-orders/actions.test.ts", "prisma/inventory-purchase-orders.test.ts", "prisma/inventory-purchase-orders-migration.test.ts"],
      poReceiving: ["src/lib/inventory-purchase-orders/receiving-domain.test.ts", "prisma/inventory-po-receiving.test.ts"],
    };
    const selected = process.argv.slice(2);
    assert.ok(selected.every(name => Object.hasOwn(groups, name)), "Unknown inventory test group");
    for (const [name, files] of Object.entries(groups)) {
      if (selected.length && !selected.includes(name)) continue;
      console.log(`Inventory test group: ${name}`);
      await run(["--import", "tsx", "--conditions=react-server", "--test", "--test-reporter=tap", "--test-concurrency=1", ...files]);
    }
  } finally {
    try {
      if (created) {
        await control.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
        console.log(`Removed disposable database ${name}`);
      }
    }
    finally { await control.$disconnect(); }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
