BEGIN;

-- AlterTable
ALTER TABLE "StockInItem" ADD COLUMN     "approvedEstimatedAmountMicros" BIGINT,
ADD COLUMN     "approvedPurchaseUnit" "InventoryUnit",
ADD COLUMN     "approvedUnitPrice" INTEGER,
ADD COLUMN     "priceVarianceMicros" BIGINT,
ADD COLUMN     "varianceReason" TEXT;

-- Integer micro-rupiah preserves a quantity-adjusted approved amount even when
-- it is fractional rupiah. Actual commercial totals retain the existing Int.
-- Old manual rows receive only NULL columns; no historical values are changed.
ALTER TABLE "StockInItem" ADD CONSTRAINT "StockInItem_po_variance_check" CHECK (
  ("purchaseOrderLineId" IS NULL AND "approvedUnitPrice" IS NULL AND "approvedPurchaseUnit" IS NULL AND
   "approvedEstimatedAmountMicros" IS NULL AND "priceVarianceMicros" IS NULL AND "varianceReason" IS NULL) OR
  ("purchaseOrderLineId" IS NOT NULL AND "approvedUnitPrice" IS NOT NULL AND "approvedPurchaseUnit" IS NOT NULL AND
   "approvedEstimatedAmountMicros" IS NOT NULL AND "priceVarianceMicros" IS NOT NULL AND "purchaseUnitCost" IS NOT NULL AND
   "approvedUnitPrice" >= 0 AND "approvedEstimatedAmountMicros" BETWEEN 0 AND 2147483647000000 AND
   "approvedEstimatedAmountMicros"::numeric * CASE WHEN "approvedPurchaseUnit" IN ('kg','L') THEN 1000 ELSE 1 END =
     "baseQuantity" * "approvedUnitPrice"::numeric * 1000000 AND
   "priceVarianceMicros"::numeric = "lineTotal"::numeric * 1000000 - "approvedEstimatedAmountMicros" AND
   ("priceVarianceMicros" <= 0 OR ("varianceReason" IS NOT NULL AND length(btrim("varianceReason")) > 0)) AND
   ("varianceReason" IS NULL OR length("varianceReason") <= 2000))
);
ALTER TABLE "InventoryPurchaseOrderEvent" DROP CONSTRAINT "InventoryPOEvent_values_check";
ALTER TABLE "InventoryPurchaseOrderEvent" ADD CONSTRAINT "InventoryPOEvent_values_check" CHECK (
  "revision" > 0 AND length("fingerprint") = 64 AND jsonb_typeof("snapshot") = 'object' AND
  "operation" IN ('CREATE','EDIT','SUBMIT','APPROVE','REJECT','ORDER','RECEIVE') AND
  ("note" IS NULL OR length("note") <= 2000)
);

CREATE OR REPLACE FUNCTION protect_inventory_po() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE remaining_count BIGINT; receipt_count BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Inventory PO deletion prohibited'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.revision <> 1 OR NEW."submittedAt" IS NOT NULL OR NEW."orderedAt" IS NOT NULL THEN
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
    (OLD.status = 'APPROVED' AND NEW.status = 'ORDERED') OR
    (OLD.status IN ('ORDERED','PARTIALLY_RECEIVED') AND NEW.status IN ('PARTIALLY_RECEIVED','RECEIVED'))) THEN
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
  IF (OLD."orderedAt" IS NOT NULL AND NEW."orderedAt" IS DISTINCT FROM OLD."orderedAt") OR
    (NEW.status NOT IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED') AND NEW."orderedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid order evidence';
  END IF;
  IF NEW.status IN ('PARTIALLY_RECEIVED','RECEIVED') THEN
    SELECT count(*) INTO receipt_count FROM "StockIn" WHERE "purchaseOrderId" = NEW.id;
    SELECT count(*) INTO remaining_count FROM "InventoryPurchaseOrderLine" l WHERE l."purchaseOrderId" = NEW.id AND
      l."baseQuantity" <> COALESCE((SELECT sum(i."baseQuantity") FROM "StockInItem" i WHERE i."purchaseOrderLineId" = l.id), 0);
    IF receipt_count = 0 OR (NEW.status = 'RECEIVED') <> (remaining_count = 0) THEN
      RAISE EXCEPTION 'Invalid inventory PO receiving transition';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION check_inventory_po_receipt_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE po_id UUID; po_supplier UUID; po_status "InventoryPurchaseOrderStatus"; line_row "InventoryPurchaseOrderLine";
  received NUMERIC; resolved UUID;
BEGIN
  IF TG_TABLE_NAME = 'StockIn' THEN
    IF NEW."purchaseOrderId" IS NOT NULL THEN
      SELECT "supplierId", status INTO po_supplier, po_status FROM "InventoryPurchaseOrder" WHERE id = NEW."purchaseOrderId" FOR UPDATE;
      IF po_supplier IS DISTINCT FROM NEW."supplierId" THEN RAISE EXCEPTION 'Inventory PO receipt supplier mismatch'; END IF;
      IF po_status NOT IN ('ORDERED','PARTIALLY_RECEIVED') THEN RAISE EXCEPTION 'Inventory PO receipt requires ordered terms'; END IF;
    END IF;
  ELSE
    SELECT "purchaseOrderId" INTO po_id FROM "StockIn" WHERE id = NEW."stockInId";
    IF (po_id IS NULL) <> (NEW."purchaseOrderLineId" IS NULL) THEN RAISE EXCEPTION 'Inventory PO receipt line link required'; END IF;
    IF NEW."purchaseOrderLineId" IS NOT NULL THEN
      PERFORM id FROM "InventoryPurchaseOrder" WHERE id = po_id FOR UPDATE;
      SELECT * INTO line_row FROM "InventoryPurchaseOrderLine" WHERE id = NEW."purchaseOrderLineId";
      IF line_row."purchaseOrderId" IS DISTINCT FROM po_id OR line_row."baseUnit" IS DISTINCT FROM NEW."baseUnit" OR
        (line_row."ingredientId" IS NOT NULL AND line_row."ingredientId" <> NEW."ingredientId") OR
        line_row."estimatedUnitPrice" IS DISTINCT FROM NEW."approvedUnitPrice" OR line_row."purchaseUnit" IS DISTINCT FROM NEW."approvedPurchaseUnit" THEN
        RAISE EXCEPTION 'Inventory PO receipt line identity or estimate mismatch';
      END IF;
      SELECT COALESCE(sum("baseQuantity"),0) INTO received FROM "StockInItem" WHERE "purchaseOrderLineId" = line_row.id;
      IF received + NEW."baseQuantity" > line_row."baseQuantity" THEN RAISE EXCEPTION 'Inventory PO overreceipt'; END IF;
      SELECT "ingredientId" INTO resolved FROM "StockInItem" WHERE "purchaseOrderLineId" = line_row.id LIMIT 1;
      IF resolved IS NOT NULL AND resolved <> NEW."ingredientId" THEN RAISE EXCEPTION 'Inventory PO resolved identity is immutable'; END IF;
      IF EXISTS (SELECT 1 FROM "InventoryPurchaseOrderLine" l LEFT JOIN "StockInItem" i ON i."purchaseOrderLineId" = l.id
        WHERE l."purchaseOrderId" = po_id AND l.id <> line_row.id AND (l."ingredientId" = NEW."ingredientId" OR i."ingredientId" = NEW."ingredientId")) THEN
        RAISE EXCEPTION 'Inventory PO duplicate resolved ingredient';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- A linked receipt must commit with its event and quantity-derived PO status.
-- This is an integrity check, not a second balance or costing engine.
CREATE FUNCTION check_inventory_po_receipt_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt_id UUID; po_id UUID; po_status "InventoryPurchaseOrderStatus"; outstanding BIGINT; item_count BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'StockIn' THEN receipt_id := NEW.id;
  ELSE receipt_id := NEW."stockInId"; END IF;
  SELECT "purchaseOrderId" INTO po_id FROM "StockIn" WHERE id = receipt_id;
  IF po_id IS NULL THEN RETURN NULL; END IF;
  SELECT status INTO po_status FROM "InventoryPurchaseOrder" WHERE id = po_id;
  SELECT count(*) INTO outstanding FROM "InventoryPurchaseOrderLine" l WHERE l."purchaseOrderId" = po_id AND
    l."baseQuantity" <> COALESCE((SELECT sum(i."baseQuantity") FROM "StockInItem" i WHERE i."purchaseOrderLineId" = l.id),0);
  SELECT count(*) INTO item_count FROM "StockInItem" WHERE "stockInId" = receipt_id;
  IF item_count = 0 OR po_status NOT IN ('PARTIALLY_RECEIVED','RECEIVED') OR (po_status = 'RECEIVED') <> (outstanding = 0) OR
    NOT EXISTS (SELECT 1 FROM "InventoryPurchaseOrderEvent" e WHERE e."purchaseOrderId" = po_id AND e.operation = 'RECEIVE' AND
      e.snapshot->'result'->>'stockInId' = receipt_id::text) THEN RAISE EXCEPTION 'Inventory PO receipt, progress and event must commit together'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_po_receipt_commit AFTER INSERT ON "StockIn" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_inventory_po_receipt_commit();
CREATE CONSTRAINT TRIGGER inventory_po_receipt_item_commit AFTER INSERT ON "StockInItem" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_inventory_po_receipt_commit();

COMMIT;
