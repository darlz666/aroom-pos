BEGIN;

ALTER TABLE "Payment" ADD COLUMN "requestFingerprint" TEXT;
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_amount_check" CHECK ("amount" >= 0),
  ADD CONSTRAINT "Payment_success_time_check" CHECK (
    ("status" = 'SUCCEEDED') = ("succeededAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "Payment_method_fields_check" CHECK (
    ("method" = 'CASH' OR ("cashReceived" IS NULL AND "changeAmount" IS NULL)) AND
    ("method" = 'BCA_EDC' OR "edcReference" IS NULL) AND
    ("method" = 'MIDTRANS_QRIS' OR "midtransReference" IS NULL)
  ),
  ADD CONSTRAINT "Payment_cash_check" CHECK (
    ("cashReceived" IS NULL AND "changeAmount" IS NULL AND NOT ("method" = 'CASH' AND "status" = 'SUCCEEDED')) OR
    ("cashReceived" IS NOT NULL AND "changeAmount" IS NOT NULL AND
     "cashReceived" >= "amount" AND "changeAmount"::bigint = "cashReceived"::bigint - "amount"::bigint)
  );

-- Unresolved attempts must be reconciled before retrying or switching methods.
-- This also guarantees at most one successful payment per order.
CREATE UNIQUE INDEX "Payment_one_active_or_successful_per_order"
  ON "Payment" ("orderId") WHERE "status" IN ('PENDING', 'SUCCEEDED');

CREATE FUNCTION protect_payment_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."orderId" IS DISTINCT FROM OLD."orderId"
     OR NEW."method" IS DISTINCT FROM OLD."method"
     OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."attemptIdentifier" IS DISTINCT FROM OLD."attemptIdentifier"
     OR NEW."requestFingerprint" IS DISTINCT FROM OLD."requestFingerprint"
     OR (OLD."status" = 'SUCCEEDED' AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Payment identity and successful payments are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Payment_attempt_immutable" BEFORE UPDATE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION protect_payment_attempt();

COMMIT;
