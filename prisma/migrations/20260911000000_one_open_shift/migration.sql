-- Single-register MVP: CLOSED shifts do not participate in uniqueness.
-- Deliberately fail on existing duplicate OPEN shifts; never repair financial data here.
CREATE UNIQUE INDEX "Shift_one_open_key"
ON "Shift" ("status")
WHERE "status" = 'OPEN';
