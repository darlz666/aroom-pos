BEGIN;

-- Never reinterpret existing quantities or WAC. Deploy must fail atomically if
-- a database has noncanonical masters; those require a separate audited plan.
LOCK TABLE "Ingredient", "StockInItem" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Ingredient" WHERE "baseUnit" NOT IN ('g', 'ml', 'pcs')) THEN
    RAISE EXCEPTION 'Noncanonical ingredient units require explicit data review; no balances or costs were converted';
  END IF;
END $$;

-- Also enforce the invariant on databases where the original check was removed.
ALTER TABLE "Ingredient" ADD CONSTRAINT "Ingredient_canonical_unit_safety_check"
  CHECK ("baseUnit" IN ('g', 'ml', 'pcs'));

-- Preserve original purchase units and exact conversions (SPEC sections 20/23).
-- Validation scans old rows; incompatible history aborts rather than rewriting it.
-- Cost checks, foreign keys and append-only triggers remain untouched.
ALTER TABLE "StockInItem" DROP CONSTRAINT "StockInItem_conversion_check";
ALTER TABLE "StockInItem" ADD CONSTRAINT "StockInItem_conversion_check" CHECK (
  ("inputUnit" = "baseUnit" AND "baseUnit" IN ('g', 'ml', 'pcs') AND "baseQuantity" = "inputQuantity") OR
  ("inputUnit" = 'kg' AND "baseUnit" = 'g' AND "baseQuantity" = "inputQuantity" * 1000) OR
  ("inputUnit" = 'L' AND "baseUnit" = 'ml' AND "baseQuantity" = "inputQuantity" * 1000)
);

COMMIT;
