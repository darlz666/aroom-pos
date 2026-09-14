# Milestone 2E7 acceptance verification

Verified 2026-09-14 against base HEAD `c45887d`, with acceptance assertions added
in this working tree. No application, schema, migration, or dependency changes.
No application bug was found in the requested A–E scenarios.

## Results and evidence

Final acceptance matrix (automated service/database and component evidence):

| Area | Result | Verification |
| --- | --- | --- |
| Authentication | PASS | Server authentication precedes root reads/render; real authorization guard redirects to `/login`; sensitive fields are excluded. |
| EMPTY | PASS | Both CASHIER and ADMIN receive EMPTY and the open-shift form. |
| Open shift | PASS | Both roles open with zero/positive integer cash; malformed cash rejects; same-owner retry returns EXISTING. |
| OWNED | PASS | Ownership takes priority for both roles, including ADMIN; opening cash and close controls are visible. |
| ADMIN_VIEW | PASS | Other-owner admin sees opening cash and close controls; independent nonblank admin reason is required; ownership stays unchanged. |
| OCCUPIED | PASS | Other cashier receives no opening cash, sees no close controls, and cannot operate or close. |
| Persistence | PASS, boundary/database evidence | Logout preserves the shift; login and repeated reads recover OWNED/EXISTING; fresh PostgreSQL client recovers the persisted shift. Browser refresh was not rerun. |
| Close blockers | PASS | UNPAID orders and PENDING payments independently block without mutation; FAILED/EXPIRED/CANCELLED payments and PAID/CANCELLED orders do not independently block. |
| Reconciliation | PASS | Opening cash plus CASH/SUCCEEDED Payment.amount only; noncash and all other payment statuses excluded; Order.total, cashReceived and changeAmount are not calculation sources. |
| Permissions | PASS | Fresh authenticated actor controls server authorization; other cashier is forbidden; admin reason and discrepancy note are independently enforced. |
| Concurrency | PASS, PostgreSQL | One global OPEN shift under competing opens; competing closes yield one success; compliant Shift-first writers serialize with close. |
| Audit | PASS, PostgreSQL | One opening/closing audit per successful action; actor/owner and reconciliation retained; audit insertion failure rolls back the transaction. |
| Close UI review/confirm | PASS, component tests | Review does not call the close action; confirmation calls it once; duplicate submissions are suppressed; no optimistic success; errors retain inputs. |
| Successful close | PASS, PostgreSQL + component tests | CLOSED values and one audit persist atomically, owner stays unchanged, retries cannot rewrite the close; confirmed UI success requests authoritative refresh. |
| DB restoration | PASS, with historical limit below | Test restoration assertions passed; follow-up read-only snapshot found no OPEN shift or acceptance fixture residue. No pre-run snapshot of all closed manual rows exists for a historical field-by-field comparison. |

Detailed A–E evidence:

| Scenario | Result | Evidence |
| --- | --- | --- |
| A: unauthenticated root requires login | PASS, component/guard tests | `src/app/shift-ui.test.ts` verifies authentication before reads/render; `src/lib/auth/backend.test.ts` verifies the real `/login` redirect digest. |
| A: both roles see EMPTY/open form | PASS, PostgreSQL + component tests | `prisma/open-shift.test.ts` checks EMPTY for both roles; `shift-ui.test.ts` checks the form and safe output for both. |
| A/B: logout, login and refresh preserve shift | PASS, isolated auth + PostgreSQL tests | Real login/logout/session utilities with mocked request cookies/database verify both roles preserve the entire shift and recover OWNED/EXISTING. PostgreSQL concurrent-open tests recover the same persisted shift through a fresh client. Browser refresh itself was not exercised. |
| B: zero/positive integer cash and malformed input | PASS | PostgreSQL tests open each role with 0 and 100000 and reject malformed values; domain and form tests cover additional coercion/overflow cases. |
| B: retries, ownership and one global register | PASS | PostgreSQL tests verify one OPEN shift, one opening audit, EXISTING retries, OWNED for an admin's own shift, ADMIN_VIEW/OCCUPIED for others, and unchanged owner. Real competing transactions and the partial unique index are exercised. |
| C: visibility and permissions | PASS, service/component tests | OWNED/ADMIN_VIEW expose opening cash and close controls; only ADMIN_VIEW requires the admin reason. OCCUPIED omits cash from its returned object and has no close controls. Domain/close tests reject another cashier before dependent reads or writes. |
| C: sensitive data | PASS, allowlist/component tests | Authenticated page fixtures contain sentinel credentials, hash, session and token fields; these are excluded from output. Actions whitelist inputs/results and return safe operational errors. |
| D: UNPAID and PENDING block independently | PASS, PostgreSQL + service tests | Close fixtures verify UNPAID and PENDING for every payment method, including PENDING on CANCELLED orders. Snapshots prove rejected close attempts leave shifts, orders, payments and audits unchanged. |
| D: terminal failures and settled orders | PASS, PostgreSQL tests | FAILED/EXPIRED/CANCELLED cash attempts coexist with successful closure; PAID/CANCELLED orders do not independently block it. Fixture status changes are test setup, never automatic close-service behavior. |
| E: authoritative expected cash | PASS, PostgreSQL tests | Opening 100 + successful CASH amounts 200 + 300 = expected 600. Successful BCA_EDC 400 and MIDTRANS_QRIS 500, CASH FAILED/EXPIRED/CANCELLED 600 each, and another shift's successful CASH 999 are excluded. |
| E: CASH PENDING exclusion | PASS, PostgreSQL query + close blocker | With PENDING 700 present, close fails without mutation. The actual aggregate arguments captured from the close service, scoped to that fixture, still sum to 500. A pending payment cannot enter a saved reconciliation because close blocks first. |
| E: forbidden calculation sources | PASS, PostgreSQL tests | Fixture Order.total is deliberately amount + 7; cashReceived is amount + 1000 and changeAmount is 1000. The saved expected cash remains 600. |

Existing checks also pass for discrepancy notes, separate admin reasons, immutable
closed shifts, exactly one close audit, transaction rollback on audit failure,
concurrent closes, and Shift-first writers waiting on closure. UI tests cover
duplicate submissions, interrupted requests, safe errors and stale-shift refresh.
Future order/payment writers must follow the documented Shift-first locking
contract; this milestone cannot verify features that do not exist yet.

## Reproduction

Use the migrated, seeded development PostgreSQL database with an idle register.
Database files must run sequentially. Tests roll back their temporary fixtures or
clean only their reserved UUIDs in `finally`; restoration assertions passed.

```powershell
pnpm.cmd exec tsx --conditions=react-server --test --test-concurrency=1 src/lib/auth/*.test.ts src/lib/shifts/*.test.ts src/app/*.test.ts prisma/shift-integrity.test.ts prisma/open-shift.test.ts prisma/close-shift.test.ts
pnpm.cmd lint
pnpm.cmd typecheck
git diff --check
```

Full acceptance run: 55 passed, 0 failed, 0 skipped. After adding the final pending
aggregate assertion, the affected auth/close files were rerun: 14 passed, 0 failed.
Lint, TypeScript and diff whitespace checks passed.

Follow-up verification (no application or test edits; no test rerun):

```powershell
node_modules/.bin/prisma.cmd validate
npm.cmd run build
git diff --check
git status --short
```

- Prisma validation: PASS, schema valid.
- Production build: PASS, Prisma Client generation, optimized Next.js compilation,
  TypeScript and page generation completed. Routes: `/`, `/_not-found`, `/admin`,
  `/login`. Generated output is ignored; no schema/dependency changes.
- Diff whitespace check: PASS. Git emitted only LF-to-CRLF conversion warnings.
- Working tree remains uncommitted; status is recorded below.

## Development database restoration follow-up

Inspected the configured development database in a PostgreSQL
`REPEATABLE READ READ ONLY` transaction; `transaction_read_only` returned `on`.
Only SELECT/SHOW queries were run, followed by ROLLBACK. No development data was
modified or cleaned, and no credentials/password hashes were selected or printed.

| Table/state | Observed count |
| --- | ---: |
| Users | 2 (existing seeded AROOM Admin and AROOM Cashier) |
| OPEN shifts | 0 |
| CLOSED shifts | 3 |
| Orders / order items | 0 / 0 |
| Payments / payment notifications | 0 / 0 |
| Audits | 6 (one SHIFT_OPENED and one SHIFT_CLOSED for each remaining shift) |
| Integrity-fixture users | 0 |
| `close-test-` orders | 0 |
| Shift audits without a corresponding shift | 0 |

Remaining development shifts:

| Shift ID | Owner role | State | Opening / expected / counted cash | Variance |
| --- | --- | --- | --- | ---: |
| `d7a4b939-db58-44f1-98d4-8cba90dd9afb` | ADMIN | CLOSED | 100000 / 100000 / 100000 | 0 |
| `2c348725-21c5-4cfe-ab5c-5f4640a70b32` | CASHIER | CLOSED | 1000 / 1000 / 1000 | 0 |
| `ae042141-9a23-4eff-ab97-9a3a762e6ef5` | CASHIER (closed by ADMIN) | CLOSED | 1000 / 1000 / 1000 | 0 |

No temporary acceptance users, orders, payments, shifts or audits remain: the
remaining rows match the seeded users and manual shift/audit records, not the
acceptance fixture values. Fixture orders/payments are absent; reserved fixture
cleanup and active-shift restoration assertions passed during the earlier runs.

There is no current real/manual active shift. The successful earlier concurrency
tests explicitly asserted that their pre-run OPEN-shift snapshot was empty, then
asserted the same snapshot after cleanup. Thus no existing active shift was
deleted or altered by those acceptance runs. This follow-up does not have a
pre-run snapshot of the three CLOSED manual shifts and cannot independently prove
historical field-by-field equality for them. No claim of such a comparison is made.

## Working tree for review

Only this acceptance report was edited in the follow-up. The following test and
README changes were already present from the earlier 2E7 work:

```text
 M prisma/close-shift.test.ts
 M prisma/open-shift.test.ts
 M src/app/shift-ui.test.ts
 M src/lib/auth/backend.test.ts
 M src/lib/shifts/README.md
?? src/lib/shifts/ACCEPTANCE.md
```

The initial PowerShell `pnpm` launch was blocked by script execution policy;
`pnpm.cmd` works. The sandboxed test runner then failed at Windows user lookup
(`uv_os_get_passwd` ENOMEM), before tests ran. The approved external-sandbox run
passed. No dependency was installed.

These results establish automated service/database and component-boundary
acceptance for A–E. Automated browser acceptance was not rerun in 2E7.
Android verification was not performed. These results do not claim browser
HTTP/hydration or physical network-disconnection verification. No order/payment workflow,
provider notification, or printer feature was added or exercised.
