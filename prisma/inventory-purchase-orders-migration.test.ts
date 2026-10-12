import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

test("PO and receiving migrations preserve pre-existing manual receipts and all inventory evidence", async () => {
  assert.notEqual(process.env.NODE_ENV, "production");
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/aroom_access_test_[a-f0-9]{32}$/);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  const rollback = new Error("rollback isolated compatibility schema");
  try {
    await assert.rejects(db.$transaction(async tx => {
      const schema = `po_${randomUUID().replaceAll("-", "")}`;
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", public`);
      await tx.$executeRawUnsafe('CREATE TABLE "AuditLog" (LIKE public."AuditLog" INCLUDING ALL)');
      const migrate = async (name: string) => tx.$executeRawUnsafe(readFileSync(new URL(`./migrations/${name}/migration.sql`, import.meta.url), "utf8")
        .replace(/^BEGIN;\s*/, "").replace(/COMMIT;\s*$/, ""));
      for (const name of ["20260919000000_stock_management_foundation", "20260920000000_stock_in",
        "20260921000000_ingredient_wac", "20260923010000_preserve_stock_in_base_unit", "20261009000000_inventory_unit_safety"]) await migrate(name);
      const actor = await tx.user.create({ data: { name: "Compatibility", loginIdentifier: randomUUID(), passwordHash: "unused", role: "STOCK_MANAGEMENT" } });
      const supplier = randomUUID(), ingredient = randomUUID(), receipt = randomUUID();
      await tx.$executeRaw`INSERT INTO "Supplier" (id, name, "updatedAt") VALUES (${supplier}::uuid, 'Historical supplier', now())`;
      await tx.$executeRaw`INSERT INTO "Ingredient" (id, name, "baseUnit", "currentStock", "weightedAverageUnitCostMicros", "updatedAt")
        VALUES (${ingredient}::uuid, 'Historical milk', 'ml', 6000, 33333000, now())`;
      await tx.$executeRaw`INSERT INTO "StockIn" (id, "referenceNumber", "idempotencyKey", "requestFingerprint", "supplierId", "supplierNameSnapshot", "receivedAt", "actorId")
        VALUES (${receipt}::uuid, ${receipt}, ${receipt}::uuid, 'historical-fingerprint', ${supplier}::uuid, 'Historical supplier', now(), ${actor.id}::uuid)`;
      await tx.$executeRaw`INSERT INTO "StockInItem" (id, "stockInId", "ingredientId", "ingredientNameSnapshot", "inputQuantity", "inputUnit", "baseQuantity", "baseUnit", "purchaseUnitCost", "receivedUnitCostMicros", "lineTotal")
        VALUES (${randomUUID()}::uuid, ${receipt}::uuid, ${ingredient}::uuid, 'Historical milk', 6, 'L', 6000, 'ml', 33333, 33333000, 199998)`;
      await tx.$executeRaw`INSERT INTO "StockMovement" (id, "ingredientId", type, quantity, unit, "stockAfter", "sourceType", "sourceId", "actorId")
        VALUES (${randomUUID()}::uuid, ${ingredient}::uuid, 'PURCHASE', 6000, 'ml', 6000, 'StockIn', ${receipt}::uuid, ${actor.id}::uuid)`;
      const snapshot = async () => {
        const rows = [];
        for (const table of ["Supplier", "Ingredient", "StockIn", "StockInItem", "StockMovement", "Recipe", "RecipeItem", "Procurement", "ProcurementEvent"]) {
          rows.push(await tx.$queryRawUnsafe(`SELECT to_jsonb(t) - ARRAY['purchaseOrderId','purchaseOrderLineId','approvedUnitPrice','approvedPurchaseUnit','approvedEstimatedAmountMicros','priceVarianceMicros','varianceReason'] AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`));
        }
        return rows;
      };
      const before = await snapshot();
      await migrate("20261011000000_inventory_purchase_orders");
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(await tx.$queryRaw`SELECT "purchaseOrderId" FROM "StockIn"`, [{ purchaseOrderId: null }]);
      assert.deepEqual(await tx.$queryRaw`SELECT "purchaseOrderLineId" FROM "StockInItem"`, [{ purchaseOrderLineId: null }]);
      await migrate("20261012000000_inventory_po_receiving");
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(await tx.$queryRaw`SELECT "approvedEstimatedAmountMicros", "priceVarianceMicros", "varianceReason" FROM "StockInItem"`,
        [{ approvedEstimatedAmountMicros: null, priceVarianceMicros: null, varianceReason: null }]);
      throw rollback;
    }, { timeout: 20000 }), error => error === rollback);
  } finally { await db.$disconnect(); }
});
