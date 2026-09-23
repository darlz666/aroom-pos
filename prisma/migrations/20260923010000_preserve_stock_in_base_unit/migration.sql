ALTER TABLE "StockInItem"
DROP CONSTRAINT "StockInItem_conversion_check";

ALTER TABLE "StockInItem"
ADD CONSTRAINT "StockInItem_conversion_check"
CHECK (
  ("inputUnit" = "baseUnit")
  AND
  ("baseQuantity" = "inputQuantity")
);
