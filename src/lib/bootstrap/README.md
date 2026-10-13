# Phase 4B-1: first ADMIN and operational categories

Implementation only. No operational bootstrap, migration or cutover is authorized
by this document. Preserve the old `aroom_pos` archive and complete the separately
approved backup/restore and deployment procedure first.

## First ADMIN

Use the reviewed release and generated Prisma Client with all current migrations
applied to a NEW, empty database. There are 18 migrations including the candidate
`20261013000000_category_management`. Keep the application stopped during bootstrap.
The CLI imports no dotenv configuration, does not use `DATABASE_URL`, accepts no
arguments, and refuses redirected input/output. No development seed is invoked.

Configure these process environment variables using the approved secret manager
or protected deployment launcher; do not put the connection string/password in
shell history, command arguments, logs, this document or source control:

- `BOOTSTRAP_DATABASE_URL`: explicit PostgreSQL connection secret.
- `BOOTSTRAP_EXPECTED_HOST`: exact URL hostname.
- `BOOTSTRAP_EXPECTED_PORT`: explicit port, normally `5432`.
- `BOOTSTRAP_EXPECTED_DATABASE`: approved new database name.
- `BOOTSTRAP_EXPECTED_USER`: expected PostgreSQL login.

Accepted database names are `aroom_pos_operational_<lowercase-suffix>` and isolated
`aroom_bootstrap_test_<32-hex-UUID>` names. `aroom_pos` is always rejected. URL query
parameters are restricted to `schema=public`, `sslmode` and `sslrootcert`.
Use certificate-verified TLS for nonlocal operational connections. The server's
database/user/schema/port must match; no role, schema or host override parameters
are accepted. Pending, failed, extra or checksum-mismatched migrations reject
initialization, as do unexpected public tables or any existing application rows.

After separate owner authorization, invoke `npm.cmd run admin:bootstrap` from an
interactive terminal. Confirm the exact database name, enter the Admin name and
login, then enter and confirm a hidden password. Use a password-manager-generated
password of 20–128 Unicode code points with at least eight distinct characters
and no surrounding whitespace. Shared authentication password rules are unchanged.
No password is generated or printed. The owner should enter and retain it directly
in their password manager, or use restricted expiring sharing for handover.

The existing Argon2id helper hashes/verifies the password. The existing user
management advisory lock plus application-table locks serialize bootstrap and
recheck emptiness before one transaction creates the active ADMIN and audit row.
Failure rolls back both. Repeated execution cannot reset or replace any account.
On an interrupted response, inspect safe state/login before retrying; a committed
account will cause subsequent bootstrap attempts to reject. Do not delete rows
to force another bootstrap. Errors never print provider exceptions or credentials.

Verify actual HTTPS login, ADMIN access and logout before staff access. Runtime
credentials must not be migration/owner credentials. No forced-password-change or
new account-recovery mechanism is introduced here. The previously identified
shared password-policy/reset discrepancy remains a separate owner-reviewed task.

## Category management

`/admin/categories`, linked from Admin, supports name, nonnegative integer display
order and active status. Only a currently active ADMIN may read or mutate. Names
are trimmed, 1–128 characters, and unique ignoring case/surrounding spaces across
active and inactive categories. No delete action exists. Existing product IDs,
category references, recipes, stock, costs and order snapshots are not rewritten.
Inactive categories follow the existing catalog and recipe-option filtering.

The new migration adds Category.revision, name/order/revision checks, a normalized
unique-name index and immutable Category audit records. Existing invalid or
duplicate categories fail migration without merging, renaming or deleting data.
Do not apply this clean-start candidate to the old demo database.

Category writes freshly authorize within their transaction, serialize mutations,
check expected revisions, and record before/after snapshots with an actor-bound
intent fingerprint. AuditLog UUIDs are durable retry receipts. Identical retries
replay their original result after later edits; changed intent/actor is rejected.
No-op requests retain the revision and record CATEGORY_UNCHANGED retry evidence.
History displays the latest 50 events. UI state is server-authoritative, duplicate
clicks are guarded, and uncertain actor-scoped requests survive tab reload in
sessionStorage for explicit exact replay. Storage failure blocks writes; offline
requests are not queued. Stale revisions require reload and review.

## Verification

- `node --import tsx --conditions=react-server prisma/run-phase4b-tests.ts --focused`
- `node --import tsx --conditions=react-server prisma/run-phase4b-tests.ts`
- `node node_modules/prisma/build/index.js validate`
- `npm.cmd run typecheck`
- `npm.cmd run lint`
- `git diff --check`

The runner uses local connection credentials but connects its control client to
`postgres`, never to the configured application database. It creates uniquely
named bootstrap/access/report disposable databases, verifies actual identity and
the complete migration count, runs tests sequentially with correct React conditions,
and drops only databases created by that invocation. It verifies removal and
preserves `.env`, `next.config.ts` and the Git index. Per-file logs/results go to a
new temporary directory; failed, skipped or cancelled tests make the process fail.
On forced termination inspect the printed exact test names before any cleanup;
never delete databases by prefix alone. Browser/device acceptance remains separate.
