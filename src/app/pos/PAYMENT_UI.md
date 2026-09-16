# Milestone 4B — POS manual payments

Select a saved order from **Pesanan Aktif**, review its server total and items,
then choose **Bayar pesanan**. Cash requires integer rupiah covering the total.
BCA EDC requires confirmation that the physical terminal shows APPROVED; its
reference is optional. QRIS remains disabled. Success displays the server payment
amount, method and cash/change or EDC reference. Receipt printing is a later
milestone and is not invoked by this UI.

`payment-action.ts` is only a POS Server Action transport. It forwards input to
the unchanged `confirmManualPayment()`, which authenticates each invocation and
calls the unchanged `recordManualPayment()`. No browser actor, prices, totals,
payment status or calculated change are submitted.

The payment panel captures the reviewed order ID/revision and creates one
`attemptIdentifier` at confirmation. A synchronous guard blocks duplicate taps.
Transport failure or `PAYMENT_FAILED` freezes the method, fields, order edits,
selection and exit. Explicit retry sends the identical request, including its
attempt identifier; the service resolves committed success through replay. A
later rejection never releases an uncertain attempt for replacement payment.
There is no background retry or offline queue.

Known order rejections require returning to the order, loading its authoritative
detail and reviewing it before another payment. A failed reload keeps edits and
payment disabled. Confirmed success removes the selected order and refreshes the
active list when leaving the success panel. No client revision increment or
optimistic payment success is used.

Attempt recovery is held in component memory, matching the existing POS creation
flow. Do not navigate away, reload, or close the browser with an uncertain result;
the UI warns explicitly. Durable recovery across browser restarts is not included
in this milestone. An unresolved conflict requires an administrator to inspect
the saved payment before accepting payment again. If EDC already approved, never
process another terminal charge merely because POS recording failed.

Validation:

```powershell
node_modules/.bin/tsx.cmd --test src/app/pos/pos-ui.test.ts
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
```

The isolated UI tests execute the components and POS action with mocked server
boundaries. They cover integer cash validation, physical EDC approval, safe
payloads, authoritative success, duplicate taps, offline rejection, uncertain
replay, later permission failure, revision reload and existing POS workflows.
They do not exercise a real database or physical terminal. Before rollout,
verify touch interaction on the Android tablet and a supervised cash/EDC flow.
