-- One current recipe remains on the existing unique product relation.
-- Revision is a concurrency token, not a historical recipe version.
ALTER TABLE "Recipe" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_revision_positive" CHECK ("revision" > 0);
