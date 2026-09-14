# Shift backend (through 2E5)

The opening action/UI and internal close service are implemented. There is no
close action or close UI yet. Server entrypoints must
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

Closure rejects pending/uncertain attempts and persisted UNPAID orders,
never auto-cancels them, and requires a discrepancy note for nonzero variance.
CLOSED shifts cannot be edited or reopened through application workflows.
Expected cash is openingCash plus SUM(Payment.amount) for CASH/SUCCEEDED payments
whose orders belong to the shift, never cashReceived or noncash payments.
`closeShift` queries that sum inside the locked transaction. The
Payment.amount == Order.total write invariant belongs to later milestones.
Money must be nonnegative integer rupiah within PostgreSQL Int range; variance
may be negative. Overflow fails explicitly rather than wrapping or rounding.

`closeShift(db, actor, input)` is an internal server-only API. A future entrypoint
must use `requireUser()` to obtain the actor, never request identity/role fields.
It validates the UUID before SQL, then uses `withOperableShift` to lock Shift by ID
under READ COMMITTED and check OPEN/ownership. It checks UNPAID orders and PENDING
payments (regardless of method or order status), sums CASH/SUCCEEDED amounts,
validates numeric countedCash and the independent notes, updates Shift and inserts
SHIFT_CLOSED in the same transaction. Any error rolls everything back; no automatic
retry, provider call, printing, or order/payment mutation occurs.

Existing field mapping: expected/counted cash use `expectedCash`/`countedCash`,
cashVariance uses `variance`, discrepancyNote uses `closingNote`, and close time
and state use `closedAt`/`status`. There is no dedicated admin reason field on Shift:
the trimmed `adminCloseReason` is preserved separately in `AuditLog.details`, along
with the discrepancy note, actor/owner IDs and reconciliation values. No schema
change is needed. `cashierId` is never changed. CLOSED retries fail without changing
the original reconciliation or inserting another audit. After an interrupted
request, a future caller must read the persisted state before deciding what to show.

Order/payment write services do not exist yet. All future creation, cancellation,
payment attempt updates and finalization/reconciliation flows must acquire the
Shift row lock FIRST, verify OPEN, then lock Order and Payment as needed in that
order, and hold the locks through commit. This ensures a writer either commits
before close reads its state or observes CLOSED and cannot write after close.
The close lock alone cannot protect against writers that bypass this contract.
Unexpected provider evidence for a CLOSED shift needs explicit admin reconciliation;
it must not silently rewrite the preserved closing values.

Run focused tests:

```sh
pnpm exec tsx --conditions=react-server --test src/lib/shifts/*.test.ts prisma/shift-integrity.test.ts
pnpm exec tsx --conditions=react-server --test prisma/close-shift.test.ts
```

The integrity test requires the migrated local development database and rolls
back its fixtures. It briefly locks Shift against concurrent writes.
Run database test files sequentially. Close tests also use reserved UUID fixtures
for real concurrent transactions, clean them in finally, and require an idle
development register for those cases.
