import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client";
import { hashPassword } from "../../src/lib/auth/password";
import { seedMenu, products } from "../../prisma/seed-menu";
import { saveRecipe } from "../../src/lib/inventory/recipe-service";
import { getFinanceReport } from "../../src/lib/finance/service";
import { getDailyReport } from "../../src/lib/reports/service";
import { jakartaBusinessDate } from "../../src/lib/reports/domain";

// Never load dotenv. The caller must explicitly provide a local postgres control URL.
async function main() {
  const base = new URL(process.env.AROOM_E2E_CONTROL_URL ?? "");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(base.hostname));
  assert.equal(base.pathname, "/postgres");
  assert.ok(["postgres:", "postgresql:"].includes(base.protocol));
  const protectedFiles = [".env", "next.config.ts", ".git/index"];
  const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const before = protectedFiles.map(hash);
  const migrations = readdirSync("prisma/migrations", { withFileTypes: true }).filter(e => e.isDirectory())
    .map(e => ({ name: e.name, checksum: hash(join("prisma/migrations", e.name, "migration.sql")) })).sort((a,b) => a.name.localeCompare(b.name));
  assert.equal(migrations.length, 22);
  const evidence = join(tmpdir(), `aroom-browser-${randomUUID()}`); mkdirSync(evidence);
  console.log(`Evidence: ${evidence}`);
  const name = `aroom_access_test_${randomUUID().replaceAll("-", "")}`;
  assert.match(name, /^aroom_access_test_[a-f0-9]{32}$/);
  const url = new URL(base); url.pathname = `/${name}`;
  const control = new PrismaClient({ adapter: new PrismaPg({ connectionString: base.toString() }) });
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  const identity = async (client: PrismaClient, expected: string) => {
    const [row] = await client.$queryRaw<{ name: string; schema: string }[]>`SELECT current_database() AS name, current_schema() AS schema`;
    assert.equal(row.name, expected); assert.equal(row.schema, "public");
  };
  const secret = randomBytes(32).toString("base64");
  let testPassword = "";
  const redact = (text: string) => {
    const safe = text.replace(/postgres(?:ql)?:\/\/\S+/g, "[redacted database URL]");
    return testPassword ? safe.replaceAll(testPassword, "[redacted test credential]") : safe;
  };
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url.toString(), SESSION_SECRET: secret,
    AUTH_THROTTLE_HMAC_SECRET: randomBytes(32).toString("base64"), NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1" };
  delete env.AROOM_E2E_CONTROL_URL;
  const run = (args: string[], childEnv = env) => new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: childEnv, windowsHide: true, stdio: "pipe" });
    let output = "";
    child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
    child.once("error", reject); child.once("close", code => {
      writeFileSync(join(evidence, args.includes("deploy") ? "migrations.log" : "browser.log"), redact(output));
      console.log(redact(output)); resolve(code);
    });
  });
  let created = false, server: ChildProcess | undefined, serverLog = "";
  try {
    await identity(control, "postgres");
    await control.$executeRawUnsafe(`CREATE DATABASE "${name}"`); created = true;
    await identity(db, name); console.log(`Verified disposable identity before migration: ${name}`);
    assert.equal(await run(["node_modules/prisma/build/index.js", "migrate", "deploy"]), 0);
    await identity(db, name);
    const applied = await db.$queryRaw<{ migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name`;
    assert.deepEqual(applied.map(r => ({ name: r.migration_name, checksum: r.checksum })), migrations);
    assert.ok(applied.every(r => r.finished_at && !r.rolled_back_at));
    console.log("Verified 22/22 migration names/checksums before seeding.");
    const password = randomBytes(24).toString("base64url") + "!7a"; testPassword = password;
    const passwordHash = await hashPassword(password);
    await identity(db, name);
    const cashier = await db.user.create({ data: { name: "Browser Test Cashier", role: "CASHIER", loginIdentifier: "browser-cashier", passwordHash } });
    const admin = await db.user.create({ data: { name: "Browser Test Admin", role: "ADMIN", loginIdentifier: "browser-admin", passwordHash } });
    const finance = await db.user.create({ data: { name: "Browser Test Finance", role: "FINANCE", loginIdentifier: "browser-finance", passwordHash } });
    await db.$transaction(seedMenu);
    // Synthetic recipes are test stock fixtures, not claimed production recipes.
    const ingredient = await db.ingredient.create({ data: { name: "Browser fixture stock", baseUnit: "ml", currentStock: "1000", weightedAverageUnitCostMicros: BigInt(1000000) } });
    for (const [productId, quantity] of [[products[0].id, "120"], [products.find(p => p.name === "French Fries")!.id, "10"]]) {
      await saveRecipe(db, admin, { productId, expectedRevision: null, idempotencyKey: randomUUID(), items: [{ ingredientId: ingredient.id, quantity, unit: "ml" }] });
    }
    const port = await new Promise<number>((resolve, reject) => { const probe = createServer(); probe.once("error", reject); probe.listen(0,"127.0.0.1", () => { const address = probe.address(); assert.ok(address && typeof address !== "string"); const port = address.port; probe.close(() => resolve(port)); }); });
    const appUrl = `http://127.0.0.1:${port}`;
    await identity(db, name); console.log(`Verified isolated target before loopback application startup: ${name}`);
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], { env, windowsHide: true, stdio: "pipe" });
    server.stdout?.on("data", d => { serverLog += d; }); server.stderr?.on("data", d => { serverLog += d; });
    server.on("error", e => { serverLog += e.message; });
    let ready = false;
    for (let i=0;i<90;i++) { if(server.exitCode!==null) break; try { const response = await fetch(`${appUrl}/login`, { signal: AbortSignal.timeout(3000) }); if(response.ok){ready=true;break;} } catch {} await new Promise(r=>setTimeout(r,1000)); }
    writeFileSync(join(evidence,"server.log"),redact(serverLog));
    assert.ok(ready,"Local application did not become ready; inspect server.log");
    await identity(db,name);
    const childEnv = { ...env, AROOM_BROWSER_VERIFIED: "1", AROOM_BROWSER_URL: appUrl, AROOM_BROWSER_EVIDENCE: evidence,
      AROOM_BROWSER_DATABASE: name, AROOM_BROWSER_PASSWORD: password, AROOM_BROWSER_INGREDIENT: ingredient.id };
    assert.equal(await run(["node_modules/@playwright/test/cli.js", "test", "--config=playwright.config.ts"], childEnv),0,"Browser tests failed; stop and inspect evidence");
    await identity(db,name);
    const paid = await db.order.findFirstOrThrow({ where: { status: "PAID", cashierId: cashier.id }, include: { payments: true, items: true } });
    const day = jakartaBusinessDate(paid.paidAt!);
    const daily = await getDailyReport(db,admin,day), summary = (await getFinanceReport(db,finance,{type:"DAY",value:day})).summary;
    assert.equal(daily.paidSales,60000); assert.equal(summary.paidSales,60000); assert.equal(summary.paidOrderCount,1);
    assert.equal(daily.shifts[0].expectedCash,160000);
    writeFileSync(join(evidence,"database-evidence.json"), JSON.stringify({ database:name, migrations:22, orderNumber:paid.orderNumber, total:paid.total, successfulPayments:paid.payments.filter(p=>p.status==="SUCCEEDED").length, daily, finance:summary },null,2));
    console.log("PASS: browser transaction, stock, daily report and Finance consistency.");
  } finally {
    if(server?.pid) { if(process.platform==="win32") await new Promise<void>(resolve=> { const killer=spawn("taskkill",["/PID",String(server!.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"}); killer.once("close",()=>resolve()); killer.once("error",()=>resolve()); }); else server.kill("SIGTERM"); }
    writeFileSync(join(evidence,"server.log"),redact(serverLog));
    if(created) {
      await identity(db,name);
      const orders=await db.order.findMany({select:{id:true,orderNumber:true,status:true,total:true,customerName:true,items:{select:{productNameSnapshot:true,quantity:true,unitPriceSnapshot:true,cupCustomizations:true}},payments:{select:{status:true,amount:true,cashReceived:true,changeAmount:true}}}}).catch(()=>[]);
      const ingredients=await db.ingredient.findMany({select:{name:true,currentStock:true}}).catch(()=>[]);
      const movements=await db.stockMovement.count().catch(()=>0);
      writeFileSync(join(evidence,"final-database-snapshot.json"),JSON.stringify({database:name,orders,ingredients,movements},null,2));
    }
    await db.$disconnect();
    if(created) { await identity(control,"postgres"); assert.match(name,/^aroom_access_test_[a-f0-9]{32}$/); await control.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`); const [row]=await control.$queryRaw<{n:number}[]>`SELECT count(*)::int AS n FROM pg_database WHERE datname=${name}`; assert.equal(row.n,0); console.log(`Cleanup verified: ${name}`); }
    await control.$disconnect();
    assert.deepEqual(protectedFiles.map(hash),before); assert.deepEqual(migrations.map(m=>hash(join("prisma/migrations",m.name,"migration.sql"))),migrations.map(m=>m.checksum));
    writeFileSync(join(evidence,"cleanup.json"),JSON.stringify({database:name,dropped:created,protectedFilesUnchanged:true,migrationChecksumsUnchanged:true},null,2));
    console.log("Protected files, Git index and migrations unchanged.");
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : "Browser runner failed"); process.exitCode=1; });
