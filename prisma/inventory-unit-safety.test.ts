import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../src/generated/prisma/client";
import { stockInFingerprint, stockInInput } from "../src/lib/inventory/stock-in-domain";

const safety = "20261009000000_inventory_unit_safety";
async function migrate(tx: Prisma.TransactionClient, name: string) {
  const sql = readFileSync(new URL(`./migrations/${name}/migration.sql`, import.meta.url), "utf8")
    .replace(/^BEGIN;\s*/, "").replace(/COMMIT;\s*$/, "");
  await tx.$executeRawUnsafe(sql);
}
async function isolated(work: (tx: Prisma.TransactionClient) => Promise<void>) {
  assert.notEqual(process.env.NODE_ENV, "production");
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/aroom_access_test_[a-f0-9]{32}$/);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  const rollback = new Error("rollback disposable migration schema");
  try {
    await assert.rejects(db.$transaction(async tx => {
      const schema = `unit_${randomUUID().replaceAll("-", "")}`;
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", public`);
      for (const name of ["20260919000000_stock_management_foundation", "20260920000000_stock_in",
        "20260921000000_ingredient_wac", "20260923010000_preserve_stock_in_base_unit"]) await migrate(tx, name);
      await work(tx);
      throw rollback;
    }, { timeout: 15000 }), error => error === rollback);
  } finally { await db.$disconnect(); }
}
async function rejected(tx: Prisma.TransactionClient, work: () => Promise<unknown>, pattern: RegExp) {
  await tx.$executeRawUnsafe("SAVEPOINT expected_failure");
  try { await assert.rejects(work(), pattern); }
  finally { await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT expected_failure"); }
}

test("unit safety migration preserves historical quantities, costs, recipes, movements and retry fingerprints", async () => {
  await isolated(async tx => {
    const actor = await tx.user.create({ data: { name: "Migration tester", loginIdentifier: randomUUID(), passwordHash: "unused", role: "STOCK_MANAGEMENT" } });
    const supplier = randomUUID(), ingredient = randomUUID(), receipt = randomUUID(), key = randomUUID();
    await tx.$executeRaw`INSERT INTO "Supplier" (id, name, "updatedAt") VALUES (${supplier}::uuid, 'Original supplier', now())`;
    await tx.$executeRaw`INSERT INTO "Ingredient" (id, name, "baseUnit", "currentStock", "weightedAverageUnitCostMicros", "updatedAt")
      VALUES (${ingredient}::uuid, 'Existing milk', 'ml', 100, 25000000, now())`;
    const request = { idempotencyKey: key, supplierId: supplier, receivedAt: "2026-09-20T09:00:00+07:00",
      items: [{ ingredientId: ingredient, quantity: "100", unit: "ml", unitCost: 25 }] };
    const fingerprint = stockInFingerprint(actor.id, stockInInput(request));
    await tx.$executeRaw`INSERT INTO "StockIn" (id, "referenceNumber", "idempotencyKey", "requestFingerprint", "supplierId", "supplierNameSnapshot", "receivedAt", "actorId")
      VALUES (${receipt}::uuid, ${receipt}, ${key}::uuid, ${fingerprint}, ${supplier}::uuid, 'Original supplier', '2026-09-20T02:00:00Z', ${actor.id}::uuid)`;
    await tx.$executeRaw`INSERT INTO "StockInItem" (id, "stockInId", "ingredientId", "ingredientNameSnapshot", "inputQuantity", "inputUnit", "baseQuantity", "baseUnit", "unitCost", "lineTotal")
      VALUES (${randomUUID()}::uuid, ${receipt}::uuid, ${ingredient}::uuid, 'Original milk', 100, 'ml', 100, 'ml', 25, 2500)`;
    await tx.$executeRaw`INSERT INTO "StockMovement" (id, "ingredientId", type, quantity, unit, "stockAfter", "sourceType", "sourceId", "actorId")
      VALUES (${randomUUID()}::uuid, ${ingredient}::uuid, 'PURCHASE', 100, 'ml', 100, 'StockIn', ${receipt}::uuid, ${actor.id}::uuid)`;
    const category = await tx.category.create({ data: { name: randomUUID() } });
    const product = await tx.product.create({ data: { name: randomUUID(), price: 22000, categoryId: category.id } });
    const recipe = randomUUID();
    await tx.$executeRaw`INSERT INTO "Recipe" (id, "productId", "updatedAt") VALUES (${recipe}::uuid, ${product.id}::uuid, now())`;
    await tx.$executeRaw`INSERT INTO "RecipeItem" (id, "recipeId", "ingredientId", quantity, unit)
      VALUES (${randomUUID()}::uuid, ${recipe}::uuid, ${ingredient}::uuid, 25, 'ml')`;
    const history = async () => {
      const rows: unknown[] = [];
      for (const table of ["Ingredient", "Supplier", "StockIn", "StockInItem", "StockMovement", "Recipe", "RecipeItem"]) {
        rows.push(await tx.$queryRawUnsafe(`SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY id`));
      }
      return rows;
    };
    const before = await history();
    // Reproduce both old constraints before applying the additive correction.
    await rejected(tx, () => tx.$executeRaw`INSERT INTO "Ingredient" (id, name, "baseUnit", "updatedAt")
      VALUES (${randomUUID()}::uuid, 'Noncanonical', 'L', now())`, /Ingredient_base_unit_check/);
    // Raw SQL deliberately uses the temporary schema. Prisma model queries
    // qualify public; service posting/replay is tested in stock-in-posting.test.
    const deliveryId = randomUUID();
    const delivery = async () => {
      await tx.$executeRaw`INSERT INTO "StockIn" (id, "referenceNumber", "idempotencyKey", "requestFingerprint", "supplierId", "supplierNameSnapshot", "receivedAt", "actorId")
        VALUES (${deliveryId}::uuid, ${deliveryId}, ${deliveryId}::uuid, 'delivery', ${supplier}::uuid, 'Original supplier', now(), ${actor.id}::uuid)`;
      await tx.$executeRaw`INSERT INTO "StockInItem" (id, "stockInId", "ingredientId", "ingredientNameSnapshot", "inputQuantity", "inputUnit", "baseQuantity", "baseUnit", "purchaseUnitCost", "receivedUnitCostMicros", "lineTotal")
        VALUES (${randomUUID()}::uuid, ${deliveryId}::uuid, ${ingredient}::uuid, 'Milk delivery', 6, 'L', 6000, 'ml', 33333, 33333000, 199998)`;
    };
    await rejected(tx, delivery, /StockInItem_conversion_check/);
    assert.deepEqual(await history(), before);
    await migrate(tx, safety);
    assert.deepEqual(await history(), before);
    await delivery();
    await rejected(tx, () => tx.$executeRaw`UPDATE "StockInItem" SET "inputQuantity" = 1 WHERE "stockInId" = ${receipt}::uuid`, /immutable/);
    await rejected(tx, () => tx.$executeRaw`DELETE FROM "StockMovement" WHERE "sourceId" = ${receipt}::uuid`, /append-only/);
    await rejected(tx, () => tx.$executeRaw`UPDATE "Ingredient" SET "baseUnit" = 'g' WHERE id = ${ingredient}::uuid`, /immutable/);
  });
});

test("migration refuses drifted noncanonical masters without relabeling balances or WAC", async () => {
  await isolated(async tx => {
    await tx.$executeRawUnsafe('ALTER TABLE "Ingredient" DROP CONSTRAINT "Ingredient_base_unit_check"');
    const id = randomUUID();
    await tx.$executeRaw`INSERT INTO "Ingredient" (id, name, "baseUnit", "currentStock", "weightedAverageUnitCostMicros", "updatedAt")
      VALUES (${id}::uuid, 'Legacy kilograms', 'kg', 2.5, 35000000000, now())`;
    const read = () => tx.$queryRaw`SELECT to_jsonb(i) AS row FROM "Ingredient" i WHERE id = ${id}::uuid`;
    const before = await read();
    await rejected(tx, () => migrate(tx, safety), /Noncanonical ingredient units require explicit data review/);
    assert.deepEqual(await read(), before);
  });
});

test("migration refuses inconsistent historical receipt quantities rather than repairing evidence", async () => {
  await isolated(async tx => {
    await tx.$executeRawUnsafe('ALTER TABLE "StockInItem" DROP CONSTRAINT "StockInItem_conversion_check"');
    await tx.$executeRawUnsafe('ALTER TABLE "StockInItem" ADD CONSTRAINT "StockInItem_conversion_check" CHECK (true)');
    const actor = await tx.user.create({ data: { name: "Drift tester", loginIdentifier: randomUUID(), passwordHash: "unused", role: "ADMIN" } });
    const supplier = randomUUID(), ingredient = randomUUID(), receipt = randomUUID();
    await tx.$executeRaw`INSERT INTO "Supplier" (id, name, "updatedAt") VALUES (${supplier}::uuid, 'Supplier', now())`;
    await tx.$executeRaw`INSERT INTO "Ingredient" (id, name, "baseUnit", "updatedAt") VALUES (${ingredient}::uuid, 'Milk', 'ml', now())`;
    await tx.$executeRaw`INSERT INTO "StockIn" (id, "referenceNumber", "idempotencyKey", "requestFingerprint", "supplierId", "supplierNameSnapshot", "receivedAt", "actorId")
      VALUES (${receipt}::uuid, ${receipt}, ${receipt}::uuid, 'preserve', ${supplier}::uuid, 'Supplier', now(), ${actor.id}::uuid)`;
    await tx.$executeRaw`INSERT INTO "StockInItem" (id, "stockInId", "ingredientId", "ingredientNameSnapshot", "inputQuantity", "inputUnit", "baseQuantity", "baseUnit", "unitCost", "lineTotal")
      VALUES (${randomUUID()}::uuid, ${receipt}::uuid, ${ingredient}::uuid, 'Milk', 1, 'L', 1, 'ml', 10, 10)`;
    const read = () => tx.$queryRaw`SELECT to_jsonb(i) AS row FROM "StockInItem" i`;
    const before = await read();
    await rejected(tx, () => migrate(tx, safety), /StockInItem_conversion_check/);
    assert.deepEqual(await read(), before);
  });
});
