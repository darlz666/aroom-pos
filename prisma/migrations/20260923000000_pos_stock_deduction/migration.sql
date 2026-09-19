BEGIN;

ALTER TABLE "StockMovement" ADD COLUMN "paymentId" UUID;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "StockMovement_paymentId_ingredientId_key" ON "StockMovement" ("paymentId", "ingredientId");
-- Do not rewrite any pre-7G history. Enforce the identity on every new movement.
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_sale_identity_check" CHECK (
  ("type" = 'SALE_CONSUMPTION' AND "paymentId" IS NOT NULL AND "sourceType" IS NOT NULL
    AND "sourceType" = 'Payment' AND "sourceId" IS NOT NULL AND "sourceId" = "paymentId")
  OR ("type" <> 'SALE_CONSUMPTION' AND "paymentId" IS NULL)
) NOT VALID;

COMMIT;
