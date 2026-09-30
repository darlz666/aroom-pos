CREATE TABLE "FinanceExpense" (
 "id" UUID PRIMARY KEY, "occurredAt" TIMESTAMPTZ(3) NOT NULL,
 "amount" INTEGER NOT NULL CHECK ("amount" > 0),
 "category" TEXT NOT NULL CHECK ("category" IN ('Gaji','Sewa','Listrik & Air','Internet','Maintenance','Kebersihan','Marketing','Transport Operasional','Lainnya')),
 "description" TEXT NOT NULL CHECK (length(btrim("description")) BETWEEN 1 AND 200),
 "note" TEXT CHECK (length("note") <= 1000),
 "createdBy" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL, "deletedAt" TIMESTAMPTZ(3),
 "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0)
);
CREATE INDEX "FinanceExpense_occurredAt_deletedAt_idx" ON "FinanceExpense"("occurredAt", "deletedAt");
CREATE TABLE "FinanceExpenseRequest" (
 "key" UUID PRIMARY KEY, "fingerprint" TEXT NOT NULL,
 "expenseId" UUID NOT NULL REFERENCES "FinanceExpense"("id") ON DELETE RESTRICT,
 "revision" INTEGER NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION protect_finance_expense() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Expense hard deletion prohibited'; END IF;
 IF OLD."deletedAt" IS NOT NULL OR NEW."id" <> OLD."id" OR NEW."createdBy" <> OLD."createdBy" OR NEW."createdAt" <> OLD."createdAt" OR NEW."revision" <> OLD."revision" + 1 THEN
   RAISE EXCEPTION 'Invalid expense revision';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_finance_expense BEFORE UPDATE OR DELETE ON "FinanceExpense" FOR EACH ROW EXECUTE FUNCTION protect_finance_expense();
CREATE FUNCTION protect_finance_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Expense request receipts are immutable'; END $$;
CREATE TRIGGER protect_finance_request BEFORE UPDATE OR DELETE ON "FinanceExpenseRequest" FOR EACH ROW EXECUTE FUNCTION protect_finance_request();
