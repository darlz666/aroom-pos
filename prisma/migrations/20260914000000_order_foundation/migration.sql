BEGIN;

-- Inspected development Order/OrderItem tables were empty. Do not invent
-- historical request fingerprints or modify existing orders on other targets.
LOCK TABLE "Order", "OrderItem" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Order") OR EXISTS (SELECT 1 FROM "OrderItem") THEN
    RAISE EXCEPTION 'Order foundation requires empty Order/OrderItem tables; review a preserving backfill before proceeding';
  END IF;
END $$;

ALTER TABLE "Order"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "createIdempotencyKey" UUID NOT NULL,
  ADD COLUMN "createRequestFingerprint" TEXT NOT NULL,
  ADD CONSTRAINT "Order_revision_check" CHECK ("revision" >= 1),
  ADD CONSTRAINT "Order_total_check" CHECK ("total" >= 0),
  ADD CONSTRAINT "Order_lifecycle_check" CHECK (
    ("status" = 'UNPAID' AND "paidAt" IS NULL AND "cancelledAt" IS NULL) OR
    ("status" = 'PAID' AND "paidAt" IS NOT NULL AND "cancelledAt" IS NULL) OR
    ("status" = 'CANCELLED' AND "paidAt" IS NULL AND "cancelledAt" IS NOT NULL)
  );

CREATE UNIQUE INDEX "Order_createIdempotencyKey_key" ON "Order" ("createIdempotencyKey");

ALTER TABLE "OrderItem"
  ADD CONSTRAINT "OrderItem_price_check" CHECK ("unitPriceSnapshot" >= 0),
  ADD CONSTRAINT "OrderItem_quantity_check" CHECK ("quantity" BETWEEN 1 AND 99),
  ADD CONSTRAINT "OrderItem_line_total_check" CHECK ("lineTotal" >= 0),
  ADD CONSTRAINT "OrderItem_calculation_check" CHECK (
    "lineTotal"::bigint = "unitPriceSnapshot"::bigint * "quantity"::bigint
  );

-- No column default/formatting yet. nextval gaps are intentional, never reset.
CREATE SEQUENCE order_number_seq AS BIGINT START WITH 1 INCREMENT BY 1 NO CYCLE;

CREATE FUNCTION protect_order_create_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."createIdempotencyKey" IS DISTINCT FROM OLD."createIdempotencyKey"
     OR NEW."createRequestFingerprint" IS DISTINCT FROM OLD."createRequestFingerprint" THEN
    RAISE EXCEPTION 'Original order create request fields are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "Order_create_request_immutable"
BEFORE UPDATE OF "createIdempotencyKey", "createRequestFingerprint" ON "Order"
FOR EACH ROW EXECUTE FUNCTION protect_order_create_request();

COMMIT;
