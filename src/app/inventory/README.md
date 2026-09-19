# Stock Management UI — Milestone 7D

`/inventory` guards before reads with `requireInventoryManager`. The root redirects
STOCK_MANAGEMENT here; ADMIN links here from administration. Existing POS, shifts,
orders, receipts, reports and Access Management guards are unchanged. Every
inventory Server Action also guards independently and services recheck active
database roles.

The workspace keeps all four panels mounted while switching navigation so a
receiving submission cannot be discarded by changing tabs. Stock reads return
exact decimal strings and server-calculated EMPTY/LOW/AVAILABLE status; minimum
equality is LOW, and inactive is a separate flag. No stock arithmetic occurs in
the stock cards. Failed reads hide stale stock instead of displaying false zeroes.

Suppliers use the 7C actions for complete metadata replacement, activation and
deactivation. Uncertain writes block additional mutations until a successful list
reload. Receiving calls the existing createStockInAction with inputs only; all
conversion and money calculations remain in the receiving service.

Before sending a receipt, the form stores the exact original request under
`aroom.stock-in.pending.<actorId>` in sessionStorage. It never sends automatically.
An interrupted request or reload restores locked inputs and offers an explicit
same-key retry. Only confirmed success or a definite first-attempt validation
rejection removes that request. A later rejection cannot unlock an already
uncertain submission. Browser storage failure blocks new submissions. Successful
receiving refreshes current stock and history. Storage is tab-scoped, not durable
offline synchronization; if the tab is closed or storage is cleared during an
uncertain submission, check receiving history before entering the delivery again.

History is paginated by immutable receipt creation time and ID, 25 at a time.
Detail uses the existing read action with an added safe actor-name projection and
server sum of saved line totals. Dates display in Asia/Jakarta. Request counters
discard stale list/detail responses and responses arriving after unmount.

Validation:

```sh
pnpm lint
pnpm typecheck
pnpm exec tsx prisma/run-access-tests.ts
```

The disposable PostgreSQL suite includes existing regressions, exact stock/status
reads, paging under inserts, safe snapshot detail, revoked-role rejection, and
component interaction tests for duplicate clicks, failed reads, stale responses,
supplier reload, and interrupted receiving/reload recovery.
