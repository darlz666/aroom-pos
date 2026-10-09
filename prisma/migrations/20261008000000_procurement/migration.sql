-- CreateEnum
CREATE TYPE "ProcurementStatus" AS ENUM ('DRAFT', 'WAITING_APPROVAL', 'APPROVED', 'REJECTED', 'ORDERED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProcurementCategory" AS ENUM ('FURNITURE', 'COFFEE_EQUIPMENT', 'BAR_TOOLS', 'ELECTRONICS', 'FIXTURE', 'OTHER');

-- CreateEnum
CREATE TYPE "ProcurementPriority" AS ENUM ('NORMAL', 'IMPORTANT', 'URGENT');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'PROCUREMENT';

-- CreateTable
CREATE TABLE "Procurement" (
    "id" UUID NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "category" "ProcurementCategory" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit" TEXT NOT NULL,
    "estimatedUnitPrice" INTEGER NOT NULL,
    "estimatedTotal" INTEGER NOT NULL,
    "vendor" TEXT,
    "productUrl" TEXT,
    "neededDate" DATE,
    "priority" "ProcurementPriority" NOT NULL,
    "reason" TEXT NOT NULL,
    "notes" TEXT,
    "status" "ProcurementStatus" NOT NULL DEFAULT 'DRAFT',
    "actualUnitPrice" INTEGER,
    "actualTotal" INTEGER,
    "createdBy" UUID NOT NULL,
    "decidedBy" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,
    "orderedAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Procurement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementEvent" (
    "key" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "procurementId" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "fromStatus" "ProcurementStatus",
    "toStatus" "ProcurementStatus" NOT NULL,
    "actorId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "revision" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,

    CONSTRAINT "ProcurementEvent_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Procurement_referenceNumber_key" ON "Procurement"("referenceNumber");

-- CreateIndex
CREATE INDEX "Procurement_status_createdAt_idx" ON "Procurement"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementEvent_procurementId_revision_key" ON "ProcurementEvent"("procurementId", "revision");

-- AddForeignKey
ALTER TABLE "Procurement" ADD CONSTRAINT "Procurement_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Procurement" ADD CONSTRAINT "Procurement_decidedBy_fkey" FOREIGN KEY ("decidedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementEvent" ADD CONSTRAINT "ProcurementEvent_procurementId_fkey" FOREIGN KEY ("procurementId") REFERENCES "Procurement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementEvent" ADD CONSTRAINT "ProcurementEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Procurement" ADD CONSTRAINT "Procurement_values_check" CHECK (
  "quantity" > 0 AND "estimatedUnitPrice" >= 0 AND
  "estimatedTotal"::bigint = "quantity"::bigint * "estimatedUnitPrice"::bigint AND
  (("actualUnitPrice" IS NULL AND "actualTotal" IS NULL) OR
   ("actualUnitPrice" IS NOT NULL AND "actualTotal" IS NOT NULL AND "actualUnitPrice" >= 0 AND "actualTotal"::bigint = "quantity"::bigint * "actualUnitPrice"::bigint)) AND
  "revision" > 0 AND length(btrim("itemName")) BETWEEN 1 AND 200 AND
  length(btrim("unit")) BETWEEN 1 AND 30 AND length(btrim("reason")) BETWEEN 1 AND 2000 AND
  ("vendor" IS NULL OR length("vendor") <= 200) AND
  ("productUrl" IS NULL OR length("productUrl") <= 2000) AND
  ("notes" IS NULL OR length("notes") <= 2000) AND
  ("status" <> 'CANCELLED' OR ("cancelledAt" IS NOT NULL AND "cancellationReason" IS NOT NULL AND length(btrim("cancellationReason")) BETWEEN 1 AND 2000)) AND
  ("status" <> 'REJECTED' OR ("decisionNote" IS NOT NULL AND length(btrim("decisionNote")) BETWEEN 1 AND 2000)) AND
  ("status" NOT IN ('APPROVED', 'REJECTED', 'ORDERED', 'RECEIVED') OR ("decidedBy" IS NOT NULL AND "decidedAt" IS NOT NULL AND "decidedBy" <> "createdBy")) AND
  ("status" NOT IN ('ORDERED', 'RECEIVED') OR "orderedAt" IS NOT NULL) AND
  ("status" <> 'RECEIVED' OR "receivedAt" IS NOT NULL)
);

CREATE FUNCTION protect_procurement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Procurement deletion prohibited'; END IF;
 IF NEW."id" <> OLD."id" OR NEW."createdBy" <> OLD."createdBy" OR NEW."createdAt" <> OLD."createdAt" OR NEW."referenceNumber" <> OLD."referenceNumber" OR NEW."revision" <> OLD."revision" + 1 THEN
   RAISE EXCEPTION 'Invalid procurement revision';
 END IF;
 IF NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('DRAFT','WAITING_APPROVAL','CANCELLED')) OR
   (OLD."status" = 'WAITING_APPROVAL' AND NEW."status" IN ('APPROVED','REJECTED','CANCELLED')) OR
   (OLD."status" = 'APPROVED' AND NEW."status" IN ('ORDERED','CANCELLED')) OR
   (OLD."status" = 'ORDERED' AND NEW."status" = 'RECEIVED')) THEN
   RAISE EXCEPTION 'Invalid procurement transition';
 END IF;
 IF (OLD."status" <> 'DRAFT' OR NEW."status" <> 'DRAFT') AND
   (to_jsonb(NEW) - ARRAY['status','revision','updatedAt','decidedBy','decidedAt','decisionNote','orderedAt','receivedAt','cancelledAt','cancellationReason','actualUnitPrice','actualTotal']) IS DISTINCT FROM
   (to_jsonb(OLD) - ARRAY['status','revision','updatedAt','decidedBy','decidedAt','decisionNote','orderedAt','receivedAt','cancelledAt','cancellationReason','actualUnitPrice','actualTotal']) THEN
   RAISE EXCEPTION 'Submitted procurement data is frozen';
 END IF;
 IF OLD."decidedAt" IS NOT NULL AND ROW(NEW."decidedBy", NEW."decidedAt", NEW."decisionNote") IS DISTINCT FROM ROW(OLD."decidedBy", OLD."decidedAt", OLD."decisionNote") THEN
   RAISE EXCEPTION 'Procurement decision is immutable';
 END IF;
 IF OLD."orderedAt" IS NOT NULL AND ROW(NEW."orderedAt", NEW."actualUnitPrice", NEW."actualTotal") IS DISTINCT FROM ROW(OLD."orderedAt", OLD."actualUnitPrice", OLD."actualTotal") THEN
   RAISE EXCEPTION 'Procurement order evidence is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_procurement BEFORE UPDATE OR DELETE ON "Procurement" FOR EACH ROW EXECUTE FUNCTION protect_procurement();
CREATE FUNCTION protect_procurement_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Procurement history is immutable'; END $$;
CREATE TRIGGER protect_procurement_event BEFORE UPDATE OR DELETE ON "ProcurementEvent" FOR EACH ROW EXECUTE FUNCTION protect_procurement_event();
