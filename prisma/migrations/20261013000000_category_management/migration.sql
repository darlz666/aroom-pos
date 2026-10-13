BEGIN;
-- Clean-start deployment only. Existing invalid/duplicate names fail visibly;
-- never rename, merge or delete historical categories automatically.
ALTER TABLE "Category" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Category" ADD CONSTRAINT "Category_management_values_check" CHECK (
  length(btrim("name")) BETWEEN 1 AND 128 AND "displayOrder" >= 0 AND "revision" > 0
);
CREATE UNIQUE INDEX "Category_normalized_name_key" ON "Category" (lower(btrim("name")));
-- Category audit rows also hold retry receipts and must remain immutable.
CREATE FUNCTION protect_category_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."entityType" = 'Category' THEN RAISE EXCEPTION 'Category audit is immutable'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW."entityType" = 'Category' THEN RAISE EXCEPTION 'Category audit is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_category_audit BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION protect_category_audit();
COMMIT;
