BEGIN;

-- CreateEnum
CREATE TYPE "InventoryPurchaseOrderStatus" AS ENUM ('DRAFT', 'WAITING_APPROVAL', 'APPROVED', 'REJECTED', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

-- AlterTable
ALTER TABLE "StockIn" ADD COLUMN     "purchaseOrderId" UUID;

-- AlterTable
ALTER TABLE "StockInItem" ADD COLUMN     "purchaseOrderLineId" UUID;

-- CreateTable
CREATE TABLE "InventoryPurchaseOrder" (
    "id" UUID NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "supplierId" UUID NOT NULL,
    "supplierNameSnapshot" TEXT NOT NULL,
    "createdBy" UUID NOT NULL,
    "status" "InventoryPurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "estimatedTotal" INTEGER NOT NULL,
    "notes" TEXT,
    "submittedAt" TIMESTAMPTZ(3),
    "decidedBy" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,
    "orderedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InventoryPurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryPurchaseOrderLine" (
    "id" UUID NOT NULL,
    "purchaseOrderId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "ingredientId" UUID,
    "itemNameSnapshot" TEXT NOT NULL,
    "proposedName" TEXT,
    "purchaseQuantity" DECIMAL(18,3) NOT NULL,
    "purchaseUnit" "InventoryUnit" NOT NULL,
    "baseQuantity" DECIMAL(18,3) NOT NULL,
    "baseUnit" "InventoryUnit" NOT NULL,
    "estimatedUnitPrice" INTEGER NOT NULL,
    "estimatedTotal" INTEGER NOT NULL,

    CONSTRAINT "InventoryPurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryPurchaseOrderEvent" (
    "key" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "purchaseOrderId" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "fromStatus" "InventoryPurchaseOrderStatus",
    "toStatus" "InventoryPurchaseOrderStatus" NOT NULL,
    "revision" INTEGER NOT NULL,
    "actorId" UUID NOT NULL,
    "note" TEXT,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryPurchaseOrderEvent_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "InventoryPurchaseOrder_referenceNumber_key" ON "InventoryPurchaseOrder"("referenceNumber");

-- CreateIndex
CREATE INDEX "InventoryPurchaseOrder_status_createdAt_idx" ON "InventoryPurchaseOrder"("status", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryPurchaseOrder_supplierId_idx" ON "InventoryPurchaseOrder"("supplierId");

-- CreateIndex
CREATE INDEX "InventoryPurchaseOrder_createdBy_idx" ON "InventoryPurchaseOrder"("createdBy");

-- CreateIndex
CREATE INDEX "InventoryPurchaseOrder_decidedBy_idx" ON "InventoryPurchaseOrder"("decidedBy");

-- CreateIndex
CREATE INDEX "InventoryPurchaseOrderLine_ingredientId_baseUnit_idx" ON "InventoryPurchaseOrderLine"("ingredientId", "baseUnit");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryPurchaseOrderLine_purchaseOrderId_position_key" ON "InventoryPurchaseOrderLine"("purchaseOrderId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryPurchaseOrderLine_purchaseOrderId_ingredientId_key" ON "InventoryPurchaseOrderLine"("purchaseOrderId", "ingredientId");

-- CreateIndex
CREATE INDEX "InventoryPurchaseOrderEvent_actorId_idx" ON "InventoryPurchaseOrderEvent"("actorId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryPurchaseOrderEvent_purchaseOrderId_revision_key" ON "InventoryPurchaseOrderEvent"("purchaseOrderId", "revision");

-- CreateIndex
CREATE INDEX "StockIn_purchaseOrderId_idx" ON "StockIn"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "StockInItem_purchaseOrderLineId_idx" ON "StockInItem"("purchaseOrderLineId");

-- AddForeignKey
ALTER TABLE "StockIn" ADD CONSTRAINT "StockIn_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "InventoryPurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockInItem" ADD CONSTRAINT "StockInItem_purchaseOrderLineId_fkey" FOREIGN KEY ("purchaseOrderLineId") REFERENCES "InventoryPurchaseOrderLine"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryPurchaseOrder" ADD CONSTRAINT "InventoryPurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryPurchaseOrder" ADD CONSTRAINT "InventoryPurchaseOrder_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryPurchaseOrder" ADD CONSTRAINT "InventoryPurchaseOrder_decidedBy_fkey" FOREIGN KEY ("decidedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryPurchaseOrderLine" ADD CONSTRAINT "InventoryPurchaseOrderLine_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "InventoryPurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryPurchaseOrderLine" ADD CONSTRAINT "InventoryPurchaseOrderLine_ingredientId_baseUnit_fkey" FOREIGN KEY ("ingredientId", "baseUnit") REFERENCES "Ingredient"("id", "baseUnit") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryPurchaseOrderEvent" ADD CONSTRAINT "InventoryPurchaseOrderEvent_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "InventoryPurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryPurchaseOrderEvent" ADD CONSTRAINT "InventoryPurchaseOrderEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "InventoryPurchaseOrder" ADD CONSTRAINT "InventoryPO_values_check" CHECK (
  "revision" > 0 AND "estimatedTotal" >= 0 AND length(btrim("referenceNumber")) > 0 AND
  length(btrim("supplierNameSnapshot")) BETWEEN 1 AND 128 AND
  ("notes" IS NULL OR length("notes") <= 2000) AND
  ("decisionNote" IS NULL OR length("decisionNote") <= 2000) AND
  ("status" = 'DRAFT' OR "submittedAt" IS NOT NULL) AND
  (("status" IN ('DRAFT', 'WAITING_APPROVAL') AND "decidedBy" IS NULL AND "decidedAt" IS NULL AND "decisionNote" IS NULL)
   OR ("status" NOT IN ('DRAFT', 'WAITING_APPROVAL') AND "decidedBy" IS NOT NULL AND "decidedAt" IS NOT NULL AND "decidedBy" <> "createdBy")) AND
  ("status" <> 'REJECTED' OR ("decisionNote" IS NOT NULL AND length(btrim("decisionNote")) > 0)) AND
  ("status" NOT IN ('ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED') OR "orderedAt" IS NOT NULL)
);
ALTER TABLE "InventoryPurchaseOrderLine" ADD CONSTRAINT "InventoryPOLine_values_check" CHECK (
  "position" BETWEEN 0 AND 99 AND "purchaseQuantity" > 0 AND "baseQuantity" > 0 AND
  "baseUnit" IN ('g', 'ml', 'pcs') AND length(btrim("itemNameSnapshot")) BETWEEN 1 AND 128 AND
  (("ingredientId" IS NOT NULL AND "proposedName" IS NULL) OR
   ("ingredientId" IS NULL AND "proposedName" IS NOT NULL AND length(btrim("proposedName")) BETWEEN 1 AND 128 AND "itemNameSnapshot" = "proposedName")) AND
  (("purchaseUnit" = "baseUnit" AND "baseQuantity" = "purchaseQuantity") OR
   ("purchaseUnit" = 'kg' AND "baseUnit" = 'g' AND "baseQuantity" = "purchaseQuantity" * 1000) OR
   ("purchaseUnit" = 'L' AND "baseUnit" = 'ml' AND "baseQuantity" = "purchaseQuantity" * 1000)) AND
  "estimatedUnitPrice" >= 0 AND "estimatedTotal" >= 0 AND
  "estimatedTotal"::numeric = "purchaseQuantity" * "estimatedUnitPrice"
);
CREATE UNIQUE INDEX "InventoryPOLine_proposed_name_key" ON "InventoryPurchaseOrderLine" ("purchaseOrderId", lower(btrim("proposedName"))) WHERE "proposedName" IS NOT NULL;
ALTER TABLE "InventoryPurchaseOrderEvent" ADD CONSTRAINT "InventoryPOEvent_values_check" CHECK (
  "revision" > 0 AND length("fingerprint") = 64 AND jsonb_typeof("snapshot") = 'object' AND
  "operation" IN ('CREATE', 'EDIT', 'SUBMIT', 'APPROVE', 'REJECT', 'ORDER') AND
  ("note" IS NULL OR length("note") <= 2000)
);

CREATE FUNCTION protect_inventory_po() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Inventory PO deletion prohibited'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."revision" <> 1 OR NEW."submittedAt" IS NOT NULL OR NEW."orderedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Inventory PO must start as draft';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW."createdBy", NEW."createdAt", NEW."referenceNumber") IS DISTINCT FROM
     ROW(OLD.id, OLD."createdBy", OLD."createdAt", OLD."referenceNumber") OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Invalid inventory PO revision or identity';
  END IF;
  IF NOT ((OLD.status = 'DRAFT' AND NEW.status IN ('DRAFT','WAITING_APPROVAL')) OR
    (OLD.status = 'WAITING_APPROVAL' AND NEW.status IN ('APPROVED','REJECTED')) OR
    (OLD.status = 'APPROVED' AND NEW.status = 'ORDERED')) THEN
    RAISE EXCEPTION 'Invalid inventory PO transition';
  END IF;
  IF (OLD.status <> 'DRAFT' OR NEW.status <> 'DRAFT') AND
    ROW(NEW."supplierId", NEW."supplierNameSnapshot", NEW."estimatedTotal", NEW.notes) IS DISTINCT FROM
    ROW(OLD."supplierId", OLD."supplierNameSnapshot", OLD."estimatedTotal", OLD.notes) THEN
    RAISE EXCEPTION 'Submitted inventory PO terms are frozen';
  END IF;
  IF (OLD."submittedAt" IS NOT NULL AND NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt") OR
     (NEW.status = 'DRAFT' AND NEW."submittedAt" IS NOT NULL) THEN RAISE EXCEPTION 'Invalid submission evidence'; END IF;
  IF OLD."decidedAt" IS NOT NULL AND ROW(NEW."decidedBy", NEW."decidedAt", NEW."decisionNote") IS DISTINCT FROM
    ROW(OLD."decidedBy", OLD."decidedAt", OLD."decisionNote") THEN RAISE EXCEPTION 'Inventory PO decision is immutable'; END IF;
  IF NEW.status <> 'ORDERED' AND NEW."orderedAt" IS NOT NULL THEN RAISE EXCEPTION 'Invalid order evidence'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_inventory_po BEFORE INSERT OR UPDATE OR DELETE ON "InventoryPurchaseOrder" FOR EACH ROW EXECUTE FUNCTION protect_inventory_po();

CREATE FUNCTION protect_inventory_po_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status "InventoryPurchaseOrderStatus"; parent_id UUID;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.id, NEW."purchaseOrderId") IS DISTINCT FROM ROW(OLD.id, OLD."purchaseOrderId") THEN
    RAISE EXCEPTION 'Inventory PO line identity is immutable';
  END IF;
  parent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."purchaseOrderId" ELSE NEW."purchaseOrderId" END;
  SELECT status INTO parent_status FROM "InventoryPurchaseOrder" WHERE id = parent_id FOR UPDATE;
  IF parent_status IS DISTINCT FROM 'DRAFT' THEN RAISE EXCEPTION 'Submitted inventory PO lines are frozen'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_inventory_po_line BEFORE INSERT OR UPDATE OR DELETE ON "InventoryPurchaseOrderLine" FOR EACH ROW EXECUTE FUNCTION protect_inventory_po_line();

CREATE FUNCTION protect_inventory_po_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Inventory PO history is immutable'; END $$;
CREATE TRIGGER protect_inventory_po_event BEFORE UPDATE OR DELETE ON "InventoryPurchaseOrderEvent" FOR EACH ROW EXECUTE FUNCTION protect_inventory_po_event();
-- Limit additional audit immutability to this domain; other workflows are untouched.
CREATE FUNCTION protect_inventory_po_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."entityType" = 'InventoryPurchaseOrder' THEN RAISE EXCEPTION 'Inventory PO audit is immutable'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW."entityType" = 'InventoryPurchaseOrder' THEN RAISE EXCEPTION 'Inventory PO audit is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_inventory_po_audit BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION protect_inventory_po_audit();

-- Validate the final transaction state, allowing atomic draft line replacement.
CREATE FUNCTION check_inventory_po_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id UUID; declared_total INTEGER; line_total NUMERIC; line_count BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'InventoryPurchaseOrder' THEN parent_id := NEW.id;
  ELSE parent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."purchaseOrderId" ELSE NEW."purchaseOrderId" END;
  END IF;
  SELECT "estimatedTotal" INTO declared_total FROM "InventoryPurchaseOrder" WHERE id = parent_id;
  SELECT count(*), sum("estimatedTotal") INTO line_count, line_total FROM "InventoryPurchaseOrderLine" WHERE "purchaseOrderId" = parent_id;
  IF line_count NOT BETWEEN 1 AND 100 OR declared_total IS DISTINCT FROM line_total THEN
    RAISE EXCEPTION 'Inventory PO total or line count mismatch';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_po_total AFTER INSERT OR UPDATE ON "InventoryPurchaseOrder" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_inventory_po_total();
CREATE CONSTRAINT TRIGGER inventory_po_line_total AFTER INSERT OR UPDATE OR DELETE ON "InventoryPurchaseOrderLine" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_inventory_po_total();

-- Nullable links preserve all manual receipts; no existing row is rewritten.
-- Existing append-only triggers protect new link columns too. Phase 1C must
-- supply links at INSERT, never attach them by editing historical receipts.
CREATE FUNCTION check_inventory_po_receipt_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE po_id UUID; po_supplier UUID; po_status "InventoryPurchaseOrderStatus"; line_po UUID; line_ingredient UUID; line_unit "InventoryUnit";
BEGIN
  IF TG_TABLE_NAME = 'StockIn' THEN
    IF NEW."purchaseOrderId" IS NOT NULL THEN
      SELECT "supplierId", status INTO po_supplier, po_status FROM "InventoryPurchaseOrder" WHERE id = NEW."purchaseOrderId" FOR SHARE;
      IF po_supplier IS DISTINCT FROM NEW."supplierId" THEN RAISE EXCEPTION 'Inventory PO receipt supplier mismatch'; END IF;
      IF po_status NOT IN ('ORDERED', 'PARTIALLY_RECEIVED') THEN RAISE EXCEPTION 'Inventory PO receipt requires ordered terms'; END IF;
    END IF;
  ELSE
    SELECT "purchaseOrderId" INTO po_id FROM "StockIn" WHERE id = NEW."stockInId";
    IF (po_id IS NULL) <> (NEW."purchaseOrderLineId" IS NULL) THEN RAISE EXCEPTION 'Inventory PO receipt line link required'; END IF;
    IF NEW."purchaseOrderLineId" IS NOT NULL THEN
      SELECT "purchaseOrderId", "ingredientId", "baseUnit" INTO line_po, line_ingredient, line_unit
        FROM "InventoryPurchaseOrderLine" WHERE id = NEW."purchaseOrderLineId";
      IF line_po IS DISTINCT FROM po_id OR line_unit IS DISTINCT FROM NEW."baseUnit" OR
        (line_ingredient IS NOT NULL AND line_ingredient <> NEW."ingredientId") THEN
        RAISE EXCEPTION 'Inventory PO receipt line identity mismatch';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_inventory_po_receipt_link BEFORE INSERT ON "StockIn" FOR EACH ROW EXECUTE FUNCTION check_inventory_po_receipt_link();
CREATE TRIGGER check_inventory_po_receipt_item_link BEFORE INSERT ON "StockInItem" FOR EACH ROW EXECUTE FUNCTION check_inventory_po_receipt_link();

COMMIT;
