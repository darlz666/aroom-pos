BEGIN;

-- Migration holds ingredient/history tables against receiving during reconstruction.
LOCK TABLE "Ingredient", "StockMovement", "StockInItem" IN ACCESS EXCLUSIVE MODE;
ALTER TABLE "Ingredient" RENAME COLUMN "unitCost" TO "legacyUnitCost";
ALTER TABLE "Ingredient" ADD COLUMN "weightedAverageUnitCostMicros" BIGINT;
ALTER TABLE "Ingredient" ADD CONSTRAINT "Ingredient_wac_check"
  CHECK ("weightedAverageUnitCostMicros" BETWEEN 0 AND 2147483647000000);

-- Do not promote optional, never-maintained 7B metadata into authoritative WAC.
-- Positive-only receiving gives a provable posting order via stockAfter, even
-- when transaction start timestamps and receivedAt are in the opposite order.
DO $$
DECLARE
  ingredient RECORD;
  movement RECORD;
  balance NUMERIC;
  wac NUMERIC;
  numerator NUMERIC;
  denominator NUMERIC;
  complete BOOLEAN;
  matched BIGINT;
BEGIN
  FOR ingredient IN SELECT * FROM "Ingredient" LOOP
    balance := 0; wac := 0; complete := true; matched := 0;
    FOR movement IN
      SELECT m.*, i."unitCost" AS cost, i."baseQuantity" AS received,
        i."baseUnit" AS received_unit
      FROM "StockMovement" m
      LEFT JOIN "StockInItem" i ON i."stockInId" = m."sourceId"
        AND i."ingredientId" = m."ingredientId"
      WHERE m."ingredientId" = ingredient.id
      ORDER BY m."stockAfter", m.id
    LOOP
      IF movement.type <> 'PURCHASE' OR movement."sourceType" IS DISTINCT FROM 'StockIn'
        OR movement.cost IS NULL OR movement.received IS DISTINCT FROM movement.quantity
        OR movement.received_unit IS DISTINCT FROM movement.unit
        OR movement."stockAfter" <> balance + movement.quantity THEN
        complete := false; EXIT;
      END IF;
      numerator := balance * wac + movement.quantity * movement.cost::numeric * 1000000;
      denominator := balance + movement.quantity;
      -- Exact quotient/remainder, avoiding NUMERIC division rounding before ties.
      wac := div(numerator, denominator) + CASE WHEN 2 * mod(numerator, denominator) >= denominator THEN 1 ELSE 0 END;
      balance := movement."stockAfter";
      matched := matched + 1;
    END LOOP;
    IF complete AND balance = ingredient."currentStock" AND balance > 0
      AND matched = (SELECT count(*) FROM "StockInItem" WHERE "ingredientId" = ingredient.id) THEN
      UPDATE "Ingredient" SET "weightedAverageUnitCostMicros" = wac::bigint WHERE id = ingredient.id;
    END IF;
    -- Unproven balances retain NULL; receiving rejects positive stock with NULL
    -- and HPP reports unavailable. Resolution requires reviewed opening evidence.
  END LOOP;
END $$;

CREATE FUNCTION protect_legacy_ingredient_cost() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW."legacyUnitCost" IS NOT NULL) OR
     (TG_OP = 'UPDATE' AND NEW."legacyUnitCost" IS DISTINCT FROM OLD."legacyUnitCost") THEN
    RAISE EXCEPTION 'Legacy ingredient cost is read-only metadata' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Ingredient_legacy_cost_frozen" BEFORE INSERT OR UPDATE ON "Ingredient"
  FOR EACH ROW EXECUTE FUNCTION protect_legacy_ingredient_cost();

ALTER TABLE "StockInItem" ALTER COLUMN "unitCost" DROP NOT NULL;
ALTER TABLE "StockInItem" ADD COLUMN "purchaseUnitCost" INTEGER;
ALTER TABLE "StockInItem" ADD COLUMN "receivedUnitCostMicros" BIGINT;
ALTER TABLE "StockInItem" DROP CONSTRAINT "StockInItem_cost_check";
ALTER TABLE "StockInItem" ADD CONSTRAINT "StockInItem_cost_check" CHECK (
  "lineTotal" >= 0 AND (
    ("unitCost" IS NOT NULL AND "purchaseUnitCost" IS NULL AND "unitCost" >= 0
      AND "lineTotal"::numeric = "baseQuantity" * "unitCost"
      AND ("receivedUnitCostMicros" IS NULL OR "receivedUnitCostMicros" = "unitCost"::bigint * 1000000))
    OR
    ("unitCost" IS NULL AND "purchaseUnitCost" IS NOT NULL AND "purchaseUnitCost" >= 0
      AND "receivedUnitCostMicros" IS NOT NULL
      AND "lineTotal"::numeric = "inputQuantity" * "purchaseUnitCost"
      AND "receivedUnitCostMicros"::numeric * CASE WHEN "inputUnit" IN ('kg', 'L') THEN 1000 ELSE 1 END = "purchaseUnitCost"::numeric * 1000000)
  )
);
ALTER TABLE "StockInItem" ADD CONSTRAINT "StockInItem_received_cost_check"
  CHECK ("receivedUnitCostMicros" BETWEEN 0 AND 2147483647000000);

COMMIT;
