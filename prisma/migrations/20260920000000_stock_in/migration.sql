BEGIN;

CREATE TABLE "StockIn" (
  "id" UUID NOT NULL,
  "referenceNumber" TEXT NOT NULL,
  "idempotencyKey" UUID NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "supplierId" UUID NOT NULL,
  "supplierNameSnapshot" TEXT NOT NULL,
  "receivedAt" TIMESTAMPTZ(3) NOT NULL,
  "actorId" UUID NOT NULL,
  "notes" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockIn_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StockIn_reference_check" CHECK (length(btrim("referenceNumber")) > 0),
  CONSTRAINT "StockIn_supplier_name_check" CHECK (length(btrim("supplierNameSnapshot")) BETWEEN 1 AND 128),
  CONSTRAINT "StockIn_notes_check" CHECK (length("notes") <= 1000),
  CONSTRAINT "StockIn_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "StockIn_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StockIn_referenceNumber_key" ON "StockIn" ("referenceNumber");
CREATE UNIQUE INDEX "StockIn_idempotencyKey_key" ON "StockIn" ("idempotencyKey");
CREATE INDEX "StockIn_supplierId_receivedAt_idx" ON "StockIn" ("supplierId", "receivedAt");
CREATE INDEX "StockIn_actorId_idx" ON "StockIn" ("actorId");

CREATE TABLE "StockInItem" (
  "id" UUID NOT NULL,
  "stockInId" UUID NOT NULL,
  "ingredientId" UUID NOT NULL,
  "ingredientNameSnapshot" TEXT NOT NULL,
  "inputQuantity" DECIMAL(18,3) NOT NULL,
  "inputUnit" "InventoryUnit" NOT NULL,
  "baseQuantity" DECIMAL(18,3) NOT NULL,
  "baseUnit" "InventoryUnit" NOT NULL,
  "unitCost" INTEGER NOT NULL,
  "lineTotal" INTEGER NOT NULL,
  CONSTRAINT "StockInItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StockInItem_name_check" CHECK (length(btrim("ingredientNameSnapshot")) BETWEEN 1 AND 128),
  CONSTRAINT "StockInItem_quantity_check" CHECK (
    "inputQuantity" > 0 AND "inputQuantity" < 'NaN'::numeric AND
    "baseQuantity" > 0 AND "baseQuantity" < 'NaN'::numeric
  ),
  CONSTRAINT "StockInItem_conversion_check" CHECK (
    ("inputUnit" = "baseUnit" AND "baseUnit" IN ('g', 'ml', 'pcs') AND "baseQuantity" = "inputQuantity") OR
    ("inputUnit" = 'kg' AND "baseUnit" = 'g' AND "baseQuantity" = "inputQuantity" * 1000) OR
    ("inputUnit" = 'L' AND "baseUnit" = 'ml' AND "baseQuantity" = "inputQuantity" * 1000)
  ),
  CONSTRAINT "StockInItem_cost_check" CHECK ("unitCost" >= 0 AND "lineTotal" >= 0 AND "lineTotal"::numeric = "baseQuantity" * "unitCost"),
  CONSTRAINT "StockInItem_stockInId_fkey" FOREIGN KEY ("stockInId") REFERENCES "StockIn"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "StockInItem_ingredientId_baseUnit_fkey" FOREIGN KEY ("ingredientId", "baseUnit") REFERENCES "Ingredient"("id", "baseUnit") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "StockInItem_stockInId_ingredientId_key" ON "StockInItem" ("stockInId", "ingredientId");
CREATE INDEX "StockInItem_ingredientId_baseUnit_idx" ON "StockInItem" ("ingredientId", "baseUnit");
-- Existing movements retain their source semantics. Receiving has one PURCHASE
-- per transaction/ingredient, even if a future writer accidentally repeats it.
CREATE UNIQUE INDEX "StockMovement_stock_in_purchase_key"
  ON "StockMovement" ("sourceId", "ingredientId")
  WHERE "sourceType" = 'StockIn' AND "type" = 'PURCHASE';

CREATE FUNCTION protect_stock_in() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Stock In records are immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER "StockIn_immutable" BEFORE UPDATE OR DELETE ON "StockIn"
  FOR EACH ROW EXECUTE FUNCTION protect_stock_in();
CREATE TRIGGER "StockInItem_immutable" BEFORE UPDATE OR DELETE ON "StockInItem"
  FOR EACH ROW EXECUTE FUNCTION protect_stock_in();

COMMIT;
