# Milestone 4A — Payment foundation

Backend only. No payment UI, Server Action, HTTP endpoint, gateway, webhook,
receipt, or printer integration is exposed. The existing payment enums and
models already matched SPEC.md; this milestone adds payment integrity and a
server-computed request fingerprint. No unrelated schema changes.

## Server contract

`confirmManualPayment(input)` in `server.ts` calls `requireUser()` on every
invocation and supplies that fresh actor to `recordManualPayment(db, actor,
input)`. The latter is an internal, injectable server service, like the order
services. Never pass an actor obtained from request data. Both roles may operate
their own OPEN shift; ADMIN may assist another shift owner.

Input is a strict object:

```ts
{
  orderId: string;             // UUID
  expectedRevision: number;    // revision the cashier reviewed
  attemptIdentifier: string;   // UUID retained across retries
  method: "CASH";
  cashReceived: number;        // integer rupiah, not an order total
}
// Or method: "BCA_EDC", optional edcReference: string (max 100 characters).
// Do not send cashReceived for EDC.
```

Calling this service means the cashier confirmed cash receipt or approval on the
physical EDC terminal. There is no generic “mark paid” method. MIDTRANS_QRIS is
rejected; a later milestone must introduce verified backend provider evidence.

Client `amount`, `total`, actor, status, shift and timestamp fields are rejected.
The service checks saved line arithmetic and order total against saved snapshots,
then validates current product availability and price. Price drift returns
`PRICE_CHANGED` without changing snapshots or paying: explicit order review is
required. This milestone does not add a reprice workflow. Menu name changes never
rewrite historical snapshots. Zero-total orders remain supported as allowed by
the existing order money rules; money must fit PostgreSQL Int.

## Transactions and recovery

- Lock the persisted Shift, then Order, then existing Payments. The shift lock
  is shared with edit, cancel, creation and closing services.
- Only a current-revision UNPAID order can become PAID. PENDING or SUCCEEDED
  attempts block another payment, including switching methods. FAILED, EXPIRED
  and CANCELLED attempts permit a new attempt.
- Record SUCCEEDED payment, PAID order, matching success timestamps, one revision
  increment and actor audit in one database transaction. Preserve order owner,
  items, totals and shift ownership.
- A repeated key with the same normalized request and actor returns the original
  success, including after shift closure. This is recovery, not another payment.
  Changed input or actor returns `IDEMPOTENCY_CONFLICT`. Legacy attempts without
  a fingerprint cannot be replayed through this service.
- Unknown database or connectivity failures return `PAYMENT_FAILED`. This does
  **not** establish that payment failed: retain and retry the exact same key and
  request to recover the committed result. Never blindly use a new key or repeat
  the physical EDC charge. The service performs no automatic retries.
- Results contain payment ID, order ID, method, status, amount, cash/change or EDC
  reference, success time and replay flag. No fingerprint or provider credentials.
- Printing has no dependency on this module and cannot reverse its transaction.

## Database migration

`20260915000000_payment_foundation` adds nullable `requestFingerprint` so existing
attempts need no invented identity. SQL enforces nonnegative amounts, success
timestamps, method-specific fields, exact cash change and cash tender on success.
A partial unique index allows only one PENDING or SUCCEEDED attempt per order,
while allowing multiple unsuccessful attempts. The original global attempt-key
uniqueness remains. A trigger protects attempt identity and all successful payment
fields against updates, including stale failure notifications.

These SQL constraints/index/trigger are not fully expressible in Prisma schema;
preserve the migration and use migrations, not `db push`. Existing invalid data
causes migration failure and needs a preserving review; the migration never
deletes or rewrites payment history. Cross-table amount equality, allowed order
transitions and atomic success evidence are enforced by the service transaction;
database row constraints alone are not a payment API. Existing notification
schema remains unused until the gateway milestone.

## Validation

Run from the repository root on local PostgreSQL:

```powershell
node_modules/.bin/prisma.cmd validate
node_modules/.bin/prisma.cmd migrate status
node_modules/.bin/tsx.cmd --conditions=react-server prisma/run-payment-tests.ts
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
```

The test runner requires local CREATE DATABASE permission. It creates a uniquely
named database, applies all migrations, seeds two test-only users, runs payment,
order and shift tests sequentially, and drops only that database in `finally`.
It does not close the live development shift. If the process is forcibly killed,
its `aroom_payment_test_…` database may need manual cleanup.

Coverage includes strict input, authenticated boundary, snapshot/price checks,
permissions, stale revision, cash/change, manual EDC, duplicate keys, concurrent
competing payments/cancellation, rollback, uncertain commit recovery, immutable
success, pending blockers, shift reconciliation, and post-close replay. No printer
or gateway is invoked.
