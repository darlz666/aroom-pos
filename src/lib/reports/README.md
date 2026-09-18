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
