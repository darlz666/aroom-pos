# Milestone 6D — Order history, detail and reprint

`/orders` authenticates on the server and uses the 6C history actions. The shift
dashboard links to it regardless of register state. No OPEN shift is required.
Cashier visibility follows the historical shift owner, including orders created
by an assisting Admin; Admin can view across shifts. Every action authenticates
again and retains the existing server-only services and safe DTOs.

The list uses the server's descending `(createdAt, id)` cursor, with next-page,
first-page and explicit current-page refresh controls. Search submits an exact
trimmed, uppercased order number, resets pagination, and relies on server input
validation. Each page is a fresh read, not a frozen snapshot across pages.
Request counters discard superseded list/detail/receipt successes and failures.
Failed reads show explicit retries rather than empty or stale financial data.

Details display saved snapshots and separate order/payment states, integer rupiah
and Asia/Jakarta timestamps. They expose no edit, cancel or payment operations.
Paid reprints fetch the authorized paid-only receipt projection, show a
COPY / SALINAN preview and pass COPY mode through the existing ReceiptPanel,
PrinterAdapter and 58 mm formatter. Printing requires an explicit tap; duplicate
taps share the existing guarded job. Failed printing retries the same snapshot.
A successful job stays disabled; closing and reopening the receipt starts an
explicit new copy. Printing never writes order or payment state.

The production adapter remains unconfigured and reports an actionable error.
This milestone does not select an Android bridge or claim physical printer
compatibility. Fake adapters are used only in tests. Validate the final tablet
layout and physical printer separately before rollout.

Focused verification:

```powershell
node_modules/.bin/tsx.cmd --test src/app/orders/order-history-ui.test.ts src/app/pos/receipt-ui.test.ts src/lib/printing/printing.test.ts
node_modules/.bin/tsx.cmd --test src/lib/orders/history.test.ts src/lib/orders/receipt.test.ts
node_modules/.bin/tsx.cmd --test src/app/pos/pos-e2e.test.ts
npm.cmd run lint
npm.cmd run typecheck
```

UI tests execute the real components with isolated hook/action boundaries and
the real print service. Application coverage connects the UI to the historical
read services over an in-memory database fixture; it verifies authorization and
unchanged financial records through print failure and retry. These are not live
browser, PostgreSQL or physical printer tests.
