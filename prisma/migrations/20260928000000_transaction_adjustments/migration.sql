BEGIN;
-- CreateTable
CREATE TABLE "TransactionAdjustment" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "idempotencyKey" UUID NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" UUID NOT NULL,
    "effectivePaidAt" TIMESTAMPTZ(3) NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "channelFee" INTEGER NOT NULL,
    "reason" TEXT,

    CONSTRAINT "TransactionAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionAdjustmentItem" (
    "id" UUID NOT NULL,
    "adjustmentId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "productName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitSellingPrice" INTEGER NOT NULL,
    "unitHpp" INTEGER,

    CONSTRAINT "TransactionAdjustmentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionVoid" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" UUID NOT NULL,
    "reason" TEXT,

    CONSTRAINT "TransactionVoid_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TransactionAdjustment_idempotencyKey_key" ON "TransactionAdjustment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "TransactionAdjustment_effectivePaidAt_idx" ON "TransactionAdjustment"("effectivePaidAt");

-- CreateIndex
CREATE INDEX "TransactionAdjustment_actorId_idx" ON "TransactionAdjustment"("actorId");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionAdjustment_orderId_revision_key" ON "TransactionAdjustment"("orderId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionAdjustmentItem_adjustmentId_position_key" ON "TransactionAdjustmentItem"("adjustmentId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionVoid_orderId_key" ON "TransactionVoid"("orderId");

-- CreateIndex
CREATE INDEX "TransactionVoid_actorId_idx" ON "TransactionVoid"("actorId");

-- AddForeignKey
ALTER TABLE "TransactionAdjustment" ADD CONSTRAINT "TransactionAdjustment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionAdjustment" ADD CONSTRAINT "TransactionAdjustment_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionAdjustmentItem" ADD CONSTRAINT "TransactionAdjustmentItem_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "TransactionAdjustment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionVoid" ADD CONSTRAINT "TransactionVoid_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionVoid" ADD CONSTRAINT "TransactionVoid_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TransactionAdjustment" ADD CONSTRAINT "TransactionAdjustment_values_check" CHECK (
  revision > 0 AND "channelFee" >= 0 AND
  length("orderNumber") BETWEEN 1 AND 100 AND "orderNumber" = btrim("orderNumber") AND
  (reason IS NULL OR length(reason) <= 500)
);
ALTER TABLE "TransactionAdjustmentItem" ADD CONSTRAINT "TransactionAdjustmentItem_values_check" CHECK (
  position BETWEEN 0 AND 99 AND quantity > 0 AND "unitSellingPrice" >= 0 AND
  ("unitHpp" IS NULL OR "unitHpp" >= 0) AND
  length("productName") BETWEEN 1 AND 200 AND "productName" = btrim("productName")
);
ALTER TABLE "TransactionVoid" ADD CONSTRAINT "TransactionVoid_reason_check" CHECK (reason IS NULL OR length(reason) <= 500);

CREATE FUNCTION protect_transaction_reporting_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Transaction reporting history is append-only' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER "TransactionAdjustment_immutable" BEFORE UPDATE OR DELETE ON "TransactionAdjustment"
FOR EACH ROW EXECUTE FUNCTION protect_transaction_reporting_history();
CREATE TRIGGER "TransactionAdjustmentItem_immutable" BEFORE UPDATE OR DELETE ON "TransactionAdjustmentItem"
FOR EACH ROW EXECUTE FUNCTION protect_transaction_reporting_history();
CREATE TRIGGER "TransactionVoid_immutable" BEFORE UPDATE OR DELETE ON "TransactionVoid"
FOR EACH ROW EXECUTE FUNCTION protect_transaction_reporting_history();

-- A committed snapshot cannot acquire additional items in a later transaction.
CREATE FUNCTION protect_transaction_adjustment_item_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE header_xid bigint;
BEGIN
  SELECT xmin::text::bigint INTO header_xid FROM "TransactionAdjustment" WHERE id = NEW."adjustmentId";
  IF header_xid IS DISTINCT FROM (pg_current_xact_id()::text::numeric % 4294967296)::bigint THEN
    RAISE EXCEPTION 'Adjustment items must be created with their header' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "TransactionAdjustmentItem_insert" BEFORE INSERT ON "TransactionAdjustmentItem"
FOR EACH ROW EXECUTE FUNCTION protect_transaction_adjustment_item_insert();
COMMIT;
