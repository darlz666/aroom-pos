# Shift foundation (2E2)

No opening/closing endpoint or UI is implemented here. Server entrypoints must
load a current active authenticated user and validate request IDs before calling
these internal helpers. Never accept the actor or shift owner from client input.

`findActiveShift` is a global read-only snapshot, not an ownership-filtered query.
Do not expose its full result to a cashier who cannot view that shift's summary.
Use `shiftHistoryWhere` for list queries and `assertCanViewShift` for detail reads.

`withOperableShift` uses READ COMMITTED and locks the shift by ID before checking
status and ownership. Keep all dependent reads and writes on its transaction
client. Future close/order/payment writers must lock Shift first, then Order,
then Payment in a consistent order. No provider calls or printing inside database
transactions. Do not automatically replay callbacks after errors or timeouts.
The row lock is a convention, not database enforcement against arbitrary writers.

No row exists to lock when opening a free register. In 2E3, check availability and
insert in one transaction, derive cashierId from authenticated actor.id, and
handle the unique-index conflict outside the failed transaction. The migration's
`Shift_one_open_key` partial index is the final concurrency guarantee; do not
replace it with uniqueness on cashierId or unconditional status uniqueness.
It is maintained in migration SQL, with no Prisma model/field changes.

ADMIN may operate another user's OPEN shift. Shift.cashierId remains the owner;
future Order.cashierId must be the authenticated creator, including assisting
ADMINs. CASHIER may operate/close only their own shift. Both roles open only
their own shifts. ADMIN closing another owner's shift requires a nonblank reason.
The close permission guard does not implement closing or all closing safeguards.

Later closure must reject pending/uncertain attempts and persisted UNPAID orders,
never auto-cancel them, and require a discrepancy note for nonzero variance.
CLOSED shifts cannot be edited or reopened through application workflows.
Expected cash is openingCash plus SUM(Payment.amount) for CASH/SUCCEEDED payments
whose orders belong to the shift, never cashReceived or noncash payments.
`calculateExpectedCash` accepts that server-derived sum; payment queries and the
Payment.amount == Order.total invariant belong to later milestones.
Money must be nonnegative integer rupiah within PostgreSQL Int range; variance
may be negative. Overflow fails explicitly rather than wrapping or rounding.

Run focused tests:

```sh
pnpm exec tsx --conditions=react-server --test src/lib/shifts/*.test.ts prisma/shift-integrity.test.ts
```

The integrity test requires the migrated local development database and rolls
back its fixtures. It briefly locks Shift against concurrent writes.
