# Milestone 7G: POS stock deduction

`recordManualPayment` calls the server-only `consumePaidOrderStock` after writing
SUCCEEDED/PAID, inside the same transaction and before commit. Throwing from any
inventory or audit write rolls everything back. Existing success replay runs
before consumption; pre-7G payments are never retroactively posted.

Lock order is Shift -> Order -> existing Payments -> Products (ID order,
FOR SHARE) -> Ingredients (ID order, FOR UPDATE). Product locks conflict with
7F's recipe-save FOR UPDATE lock, including absent recipes. All recipes are
loaded after those locks. Ingredient balances and activity are read after their
locks, shared with receiving. Recipes have no active flag; missing/empty recipes
reject new sales. Direct out-of-band recipe SQL must follow the same Product
locking protocol as the existing recipe service.

All consumption arithmetic uses BigInt thousandths. Unit normalization reuses
7B conversions. Every shared ingredient gets one aggregate movement per payment,
including duplicate product lines. `StockMovement.paymentId` is a foreign key;
the payment provides its immutable order ID. A unique payment/ingredient pair
backs up payment idempotency. Source fields, quantity, canonical unit, balance,
timestamp and actor remain in the existing append-only movement model. The
migration preserves legacy movements without inventing payment associations;
its new sale-identity check applies to every new insert.

WAC is untouched, including when stock reaches zero or WAC is unknown. No HPP
or receipt snapshot is recalculated. No UI or permissions from 7F changed.

Apply migrations and regenerate Prisma before running this version. Configure
recipes and sufficient ingredient stock before new sales; products without
recipes now return a controlled error. QRIS has no provider finalizer in this
repository yet. Cash/EDC are covered; a future verified provider finalizer must
call this integration within its success transaction and preserve external
payment evidence when local finalization requires reconciliation.

Verification uses `prisma/run-access-tests.ts` (full suite, disposable local
PostgreSQL), or `prisma/run-payment-tests.ts` (payment/order/7G subset), with
`tsx --conditions=react-server`. Coverage includes quantity precision, shared
ingredients, missing/invalid recipes, insufficient stock, duplicate clicks,
separate concurrent sales, append-only/deduplication constraints, injected
partial-write failures, lost responses, recipe locking, receiving/WAC races,
unchanged snapshots, existing authorization and closed-shift replay. Printing
remains outside the financial transaction and its existing tests cover failure.
