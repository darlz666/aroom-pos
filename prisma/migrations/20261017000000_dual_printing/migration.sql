BEGIN;

-- Nullable snapshots preserve all historical orders and existing request hashes.
ALTER TABLE "Order" ADD COLUMN "customerName" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "cupCustomizations" JSONB;

CREATE FUNCTION valid_order_print_text(value TEXT, maximum INTEGER) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT char_length(value) <= maximum AND value !~
    ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')
$$;

ALTER TABLE "Order" ADD CONSTRAINT "Order_customer_name_check" CHECK (
  "customerName" IS NULL OR valid_order_print_text("customerName", 128)
);

CREATE FUNCTION valid_order_cups(value JSONB, quantity INTEGER) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE entry JSONB;
BEGIN
  IF jsonb_typeof(value) <> 'array' THEN RETURN FALSE; END IF;
  IF jsonb_array_length(value) <> quantity OR quantity NOT BETWEEN 1 AND 99 THEN RETURN FALSE; END IF;
  FOR entry IN SELECT * FROM jsonb_array_elements(value) LOOP
    IF jsonb_typeof(entry) <> 'object' THEN RETURN FALSE; END IF;
    IF entry - ARRAY['sugar', 'ice', 'cup', 'notes'] <> '{}'::jsonb
       OR NOT (entry ?& ARRAY['sugar', 'ice', 'cup', 'notes'])
       OR jsonb_typeof(entry->'sugar') <> 'string'
       OR jsonb_typeof(entry->'ice') <> 'string'
       OR jsonb_typeof(entry->'cup') <> 'string'
       OR jsonb_typeof(entry->'notes') <> 'string'
       OR (entry->>'sugar') NOT IN ('NORMAL', 'LESS', 'NO_SUGAR')
       OR (entry->>'ice') NOT IN ('NORMAL', 'LESS', 'NO_ICE')
       OR (entry->>'cup') NOT IN ('REGULAR', 'LARGE')
       OR NOT valid_order_print_text(entry->>'notes', 300)
    THEN RETURN FALSE; END IF;
  END LOOP;
  RETURN TRUE;
END $$;

ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_cup_customizations_check" CHECK (
  "cupCustomizations" IS NULL OR valid_order_cups("cupCustomizations", "quantity")
);

-- Protect only preparation/customer snapshot changes. Existing payment, stock,
-- reporting and legacy fixture lifecycle behavior remains unchanged.
CREATE FUNCTION protect_order_customer_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."customerName" IS DISTINCT FROM OLD."customerName" AND OLD."status" <> 'UNPAID' THEN
    RAISE EXCEPTION 'Completed order customer snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Order_customer_snapshot_immutable"
BEFORE UPDATE OF "customerName" ON "Order"
FOR EACH ROW EXECUTE FUNCTION protect_order_customer_snapshot();

CREATE FUNCTION protect_order_cup_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_status "OrderStatus";
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."cupCustomizations" IS NOT DISTINCT FROM OLD."cupCustomizations"
     AND NEW."notes" IS NOT DISTINCT FROM OLD."notes" AND NEW."orderId" IS NOT DISTINCT FROM OLD."orderId" THEN
    RETURN NEW;
  END IF;
  -- Legacy inserts do not acquire new preparation metadata restrictions.
  IF TG_OP = 'INSERT' AND NEW."cupCustomizations" IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT "status" INTO target_status FROM "Order" WHERE id = OLD."orderId" FOR UPDATE;
    IF target_status <> 'UNPAID' THEN
      RAISE EXCEPTION 'Completed order preparation snapshot is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT "status" INTO target_status FROM "Order" WHERE id = NEW."orderId" FOR UPDATE;
  IF target_status <> 'UNPAID' THEN
    RAISE EXCEPTION 'Completed order preparation snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "OrderItem_cup_snapshot_immutable"
BEFORE INSERT OR UPDATE OF "cupCustomizations", "notes", "orderId" ON "OrderItem"
FOR EACH ROW EXECUTE FUNCTION protect_order_cup_snapshot();

COMMIT;
