// Run through tsx in a separate process: Playwright's transformer cannot load
// the existing generated Prisma TypeScript client (which contains import.meta).
import assert from "node:assert/strict";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client";

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/aroom_access_test_[a-f0-9]{32}$/);
  assert.equal(url.pathname.slice(1), process.env.AROOM_BROWSER_DATABASE);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  try {
    const [identity] = await db.$queryRaw<{ name: string; schema: string }[]>`SELECT current_database() AS name, current_schema() AS schema`;
    assert.equal(identity.name, url.pathname.slice(1)); assert.equal(identity.schema, "public");
    const orders = await db.order.findMany({ orderBy: { id: "asc" }, include: { items: { orderBy: { id: "asc" } }, payments: { orderBy: { id: "asc" } } } });
    const payments = await db.payment.findMany({ orderBy: { id: "asc" } });
    const movements = await db.stockMovement.findMany({ orderBy: { id: "asc" } });
    const stock = (await db.ingredient.findUniqueOrThrow({ where: { id: process.env.AROOM_BROWSER_INGREDIENT } })).currentStock.toFixed();
    const cashier = await db.user.findUniqueOrThrow({ where: { loginIdentifier: "browser-cashier" }, select: { id: true, credentialsVersion: true } });
    const result = { database: identity.name, orders, successfulPayments: payments.filter(p => p.status === "SUCCEEDED").length, stock, movementCount: movements.length, cashier,
      snapshot: JSON.stringify({ orders, payments, movements, stock }) };
    console.log(JSON.stringify(result));
  } finally { await db.$disconnect(); }
}
void main().catch(() => { console.error("Isolated database probe failed"); process.exitCode = 1; });
