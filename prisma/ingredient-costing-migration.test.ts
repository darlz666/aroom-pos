import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

test("WAC migration reconstructs proven posting history, preserves legacy evidence and rejects invented costs", async () => {
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.ok(process.env.DATABASE_URL);
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/aroom_access_test_/);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  const rollback = new Error("rollback isolated migration schema");
  try {
    await assert.rejects(db.$transaction(async tx => {
      // Run the real old/new SQL in a transaction-local schema, leaving public
      // fixtures and migration tracking untouched. Every object rolls back.
      const schema = `wac_${randomUUID().replaceAll("-", "")}`;
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", public`);
      const migrate = async (name: string) => {
        const sql = readFileSync(new URL(`./migrations/${name}/migration.sql`, import.meta.url), "utf8")
          .replace(/^BEGIN;\s*/, "").replace(/COMMIT;\s*$/, "");
        await tx.$executeRawUnsafe(sql);
      };
      await migrate("20260919000000_stock_management_foundation");
      await migrate("20260920000000_stock_in");
      const actor = await tx.user.create({ data: { name: "Migration fixture", loginIdentifier: randomUUID(), passwordHash: "unused", role: "ADMIN" } });
      const supplier = randomUUID();
      await tx.$executeRaw`INSERT INTO "Supplier" (id, name, "updatedAt") VALUES (${supplier}::uuid, 'Old supplier', now())`;
      const createIngredient = async (stock: string, legacy: number | null) => {
        const id = randomUUID();
        await tx.$executeRaw`INSERT INTO "Ingredient" (id, name, "baseUnit", "currentStock", "unitCost", "updatedAt")
          VALUES (${id}::uuid, ${id}, 'ml', ${stock}::numeric, ${legacy}, now())`;
        return id;
      };
      const receive = async (ingredient: string, qty: string, cost: number, after: string, time: string, withMovement = true) => {
        const id = randomUUID(), item = randomUUID(), movement = randomUUID();
        await tx.$executeRaw`INSERT INTO "StockIn" (id, "referenceNumber", "idempotencyKey", "requestFingerprint", "supplierId", "supplierNameSnapshot", "receivedAt", "actorId")
          VALUES (${id}::uuid, ${id}, ${id}::uuid, 'unchanged fingerprint', ${supplier}::uuid, 'Old supplier', ${time}::timestamptz, ${actor.id}::uuid)`;
        await tx.$executeRaw`INSERT INTO "StockInItem" (id, "stockInId", "ingredientId", "ingredientNameSnapshot", "inputQuantity", "inputUnit", "baseQuantity", "baseUnit", "unitCost", "lineTotal")
          VALUES (${item}::uuid, ${id}::uuid, ${ingredient}::uuid, 'Original ingredient', ${qty}::numeric, 'ml', ${qty}::numeric, 'ml', ${cost}, (${qty}::numeric * ${cost})::integer)`;
        if (withMovement) await tx.$executeRaw`INSERT INTO "StockMovement" (id, "ingredientId", type, quantity, unit, "stockAfter", "sourceType", "sourceId", "actorId", "createdAt")
          VALUES (${movement}::uuid, ${ingredient}::uuid, 'PURCHASE', ${qty}::numeric, 'ml', ${after}::numeric, 'StockIn', ${id}::uuid, ${actor.id}::uuid, ${time}::timestamptz)`;
      };
      const proven = await createIngredient("17000", 999);
      await receive(proven, "5000", 30, "5000", "2026-09-20T00:00:00Z");
      await receive(proven, "12000", 35, "17000", "2026-09-19T00:00:00Z");
      const missing = await createIngredient("10", 99);
      const inconsistent = await createIngredient("11", 99);
      await receive(inconsistent, "10", 30, "10", "2026-09-20T00:00:00Z");
      const orphan = await createIngredient("10", 99);
      await receive(orphan, "10", 30, "10", "2026-09-20T00:00:00Z", false);
      const brokenSequence = await createIngredient("10", 99);
      await receive(brokenSequence, "5", 30, "10", "2026-09-20T00:00:00Z");
      const empty = await createIngredient("0", 99);
      const history = () => tx.$queryRaw`SELECT i.id, i."inputQuantity", i."inputUnit", i."baseQuantity", i."baseUnit", i."unitCost", i."lineTotal",
        s."requestFingerprint", s."receivedAt", s."supplierNameSnapshot" FROM "StockInItem" i JOIN "StockIn" s ON s.id = i."stockInId" ORDER BY i.id`;
      const before = await history();
      await migrate("20260921000000_ingredient_wac");
      const rows = await tx.$queryRaw<{ id: string; legacyUnitCost: number | null; weightedAverageUnitCostMicros: bigint | null }[]>`
        SELECT id, "legacyUnitCost", "weightedAverageUnitCostMicros" FROM "Ingredient"`;
      assert.equal(rows.find(row => row.id === proven)?.weightedAverageUnitCostMicros, BigInt(33_529_412));
      assert.equal(rows.find(row => row.id === proven)?.legacyUnitCost, 999);
      for (const id of [missing, inconsistent, orphan, brokenSequence, empty]) assert.equal(rows.find(row => row.id === id)?.weightedAverageUnitCostMicros, null);
      assert.deepEqual(await history(), before);
      const legacy = await tx.$queryRaw<{ purchaseUnitCost: number | null; receivedUnitCostMicros: bigint | null }[]>`
        SELECT "purchaseUnitCost", "receivedUnitCostMicros" FROM "StockInItem"`;
      assert.ok(legacy.every(row => row.purchaseUnitCost === null && row.receivedUnitCostMicros === null));
      // New SQL constraints protect the only authoritative current cost.
      for (const value of [BigInt(-1), BigInt("2147483647000001")]) {
        await tx.$executeRawUnsafe("SAVEPOINT invalid_cost");
        await assert.rejects(tx.$executeRaw`UPDATE "Ingredient" SET "weightedAverageUnitCostMicros" = ${value} WHERE id = ${proven}::uuid`);
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT invalid_cost");
      }
      await tx.$executeRawUnsafe("SAVEPOINT immutable_cost");
      await assert.rejects(tx.$executeRaw`UPDATE "Ingredient" SET "legacyUnitCost" = 1 WHERE id = ${proven}::uuid`);
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT immutable_cost");
      throw rollback;
    }, { timeout: 20000 }), error => error === rollback);
  } finally { await db.$disconnect(); }
});
