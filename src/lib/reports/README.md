# Milestone 6E — Daily reporting

Admin area links to `/admin/reports`. Both page and action require a freshly
authenticated ADMIN; the internal service independently checks the supplied
server actor before any report query. Authentication itself may read User.
The only action input is a strict `YYYY-MM-DD` date, never financial values.

Daily sales aggregate Payment rows with SUCCEEDED status, a PAID parent Order,
and `succeededAt` in `[00:00 WIB, next 00:00 WIB)`. Order/attempt creation time
does not determine the business date. The existing database constraint permits
one successful payment per order, so payment counts equal paid-order counts.
No joins to items or notifications multiply amounts. Cash, BCA EDC, and QRIS
are shown separately; integer amounts and safe integer sums are required.
This reads QRIS evidence if present; it does not implement the QRIS gateway.

SPEC section 18 does not define which daily report lists a cross-midnight shift.
6E includes shifts opened before the day's end and not closed before its start
(including closure exactly at midnight), even without sales. Such a shift may
appear on multiple dates. Reconciliation is explicitly for the entire shift,
not part of the daily sales total. Open shifts use the existing cash settlement
helper across all their successful cash sales, with closing values still unset.
Closed shifts return persisted opening/expected/counted cash and variance; no
historical closing value is recomputed. Missing closed values fail explicitly.

All queries share one RepeatableRead transaction. Reporting has no writes,
provider calls, printing, schema changes, report tables, or background work.
Failures return controlled errors rather than successful zero totals. The UI
clears old financial data during date changes/loads/errors, ignores superseded
responses, guards duplicate taps, and provides explicit refresh/retry.

Service tests cover dates, inclusion/exclusion, payment attempts, method totals,
full-shift reconciliation, authorization, failures and unchanged fixtures.
Component/action tests exercise actual modules with isolated Next/hook boundaries;
they are not browser or tablet validation. Existing settlement, close, payment,
order and lifecycle tests remain regression coverage.

## Transaction details

The existing DTO also returns one transaction per successful payment/paid order,
using exactly the summary's success-time filter and RepeatableRead snapshot.
Rows sort by succeededAt descending, then payment ID descending; item snapshots
sort by item ID. Product labels use saved names and quantities, never live menu
names. Selling price and revenue both use Payment.amount (the saved full order
total); there is no pre-discount selling-price concept yet. Cash tendered is not
revenue. Only explicitly selected display data leaves the service.

Customer/table is a null placeholder. Voucher discount, POS promo, receivable,
and advertising cost are zero placeholders; total discount is voucher + promo.
These values are never persisted. Historical HPP is unavailable (null): orders
and payments do not snapshot cost, SALE_CONSUMPTION stores quantity and balance
but no WAC/cost at sale, and current recipes/WAC are mutable. Receiving history
does not guarantee complete historical opening valuations or an unambiguous
costing sequence for every sale, including pre-consumption orders. Do not use
today's recipe HPP or latest purchase cost to fill this gap. Gross profit and
net revenue remain null as well. If historical HPP becomes available in future,
the intended formulas are revenue - HPP - total discount, then gross profit -
advertising cost, calculated on the server with safe integer arithmetic.

The table follows shift reconciliation, scrolls horizontally, and reuses the
report's Rupiah and Jakarta date/time formatters. Unknown values render as `-`,
distinct from known/placeholder Rp0; the UI explains these limitations.
