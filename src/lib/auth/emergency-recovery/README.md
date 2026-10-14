# Emergency ADMIN recovery maintenance runbook

Phase 4B-2B-2 authorizes source implementation and new isolated disposable tests.
It does not authorize a real recovery, operational migration, deployment or access
to the old `aroom_pos`. Hosting and production operator identity are not finalized.
Use this runbook only after separate owner approval of the actual environment,
operator, target ADMIN, operation UUID and maintenance procedure.

## Authorization and verified evidence

Restricted host access is the authorization boundary. Require independently
authenticated operator access with SSH/MFA or equivalent approved protection.
Entering an operator name, approval reference or expected identity does not prove
authorization. The CLI cannot validate an external approval system or the human's
MFA session. The owner must authorize the actual operation independently.

The receipt distinguishes supplied metadata from observed execution evidence:

| Receipt evidence | Source and limitation |
| --- | --- |
| Operation UUID, target UUID, expected version | Explicit owner-approved intent; target/version checked against current database state. |
| Approval reference, external operator identity | Operator-supplied non-secret metadata; not proof of authorization or identity. |
| OS username, UID, hostname | Node OS APIs on the executing host, checked against explicit expected identity. Windows reports UID `-1`; it is recorded truthfully, not replaced with a fabricated identifier. This identifies process context, not the human's SSH/MFA session. |
| Database host | Explicit connection hostname checked against the independently supplied expected target; server address is separately verified. A hostname alone is not cryptographic host authentication. |
| Database port/name/public schema | Actual PostgreSQL identity observations compared with the explicit expected target, including transaction-time rechecks. |
| Database user/session user/server address | PostgreSQL `current_user`, `session_user` and `inet_server_addr()` observations compared with independent expected values. No assumed OS or application-user attribution. |
| Resulting version and timestamp | Atomic credential update and PostgreSQL-generated receipt timestamp. |
| Intent | Fixed `REPLACE_EXISTING_ACTIVE_ADMIN_CREDENTIAL`; no password-derived digest. |

Use a certificate-verified connection for any nonlocal execution and an owner-
verified server address. Reject ambiguous targets, role/schema overrides, missing
identity, pending/failed/extra migrations and any checksum mismatch. Every one of
the 21 migration names/checksums must match the reviewed source release. Never
silently load `.env`, use `DATABASE_URL`, or fall back to another database. The
old `aroom_pos` is rejected. No production connection details belong in this file.

## Before a separately approved real operation

1. Record approval through an independent owner-controlled channel. Specify the
   actual host/database/principals, existing active ADMIN UUID, expected current
   credentialsVersion, operator identity, approval reference and new operation UUID.
   A further recovery requires separate authorization and a new UUID.
2. Verify a backup using the approved backup/restore procedure before touching real
   credentials. Record safe verification evidence outside the application database.
   The CLI does not create, restore or establish the quality of a backup.
3. Apply the reviewed 21-migration release under separately approved deployment
   authorization. Keep migration/DDL credentials controlled independently from
   normal runtime DML access. Verify the deployed offline blocklist asset/checksum.
4. Establish the approved maintenance window. Stop admission/ingress on all
   application instances and drain in-flight requests, using the independently
   approved hosting/Cloudflare procedure. The CLI does not change Cloudflare,
   create a maintenance endpoint or operate deployment infrastructure.
5. Verify host OS identity and database target/principals/address through an
   independent trusted channel. Supply those expected values explicitly; copying
   values from an unverified connection does not establish the intended target.
6. Provision the explicit recovery connection secret through a protected launcher
   or approved secret manager. Do not place a connection string/password in shell
   history, command arguments, logs, tickets, audit metadata or source control.

## Execution and credential handover

Configure these process environment values through the protected launcher or
approved secret manager. Expected values must come from the independently reviewed
target, not a guessed or unverified connection:

- `RECOVERY_DATABASE_URL`: explicit PostgreSQL connection secret.
- `RECOVERY_EXPECTED_HOST`: exact connection URL hostname.
- `RECOVERY_EXPECTED_PORT`: explicit PostgreSQL port, normally `5432`.
- `RECOVERY_EXPECTED_DATABASE`: exact approved database name.
- `RECOVERY_EXPECTED_SCHEMA`: `public`.
- `RECOVERY_EXPECTED_USER`: both PostgreSQL `current_user` and `session_user`.
- `RECOVERY_EXPECTED_SERVER_ADDRESS`: verified server IP address; it must match a
  DNS result for the explicit hostname and the server's `inet_server_addr()`.
- `RECOVERY_EXPECTED_OS_USERNAME`: expected Node OS API username.
- `RECOVERY_EXPECTED_OS_UID`: expected Node OS API UID as a string (`-1` on Windows).
- `RECOVERY_EXPECTED_HOSTNAME`: expected Node OS API hostname.

The approved launcher must disable dependency debugging. The CLI rejects nonempty
`DEBUG` and `NODE_DEBUG` before any work because dependency diagnostics can expose
SQL arguments or password hashes. Do not capture credentials through terminal,
process, dependency or database diagnostics; retain only safe operation evidence.

Accepted database names are `aroom_pos_operational_<lowercase-suffix>` and isolated
`aroom_access_test_<32-hex-UUID>` names. Only `schema=public`, `sslmode` and
`sslrootcert` connection query parameters are accepted. Nonlocal hosts require
`sslmode=verify-full` and an explicit certificate root. No supplied role/search-path
override is accepted. Operational provisioning remains separately authorized.

Invoke the reviewed maintenance CLI from an interactive terminal with no arguments:

```powershell
node --import tsx --conditions=react-server prisma/recover-admin.ts
```

It is separate from HTTP routes and rejects redirected input/output. No application
`DATABASE_URL` or automatic dotenv loading is accepted. Confirm the exact database
name, then provide the owner-approved operation UUID, target ADMIN UUID, expected
credentialsVersion, approval reference and external operator metadata. The CLI first
prints safe authoritative status. For an uncommitted operation, type `STATUS` to
exit without replacement or `RECOVER` to enter the approved credential. A committed
operation exits with status before prompting for any password.

Enter and confirm a password through hidden input only. The existing recovery
policy requires 20-128 Unicode code points, the existing malformed/whitespace-only
input validation, matching confirmation and offline common-password screening.
Argon2id hashes the original bytes without trimming or normalization. Use a password
manager and a private handover: the password is
not generated, displayed, logged or recoverable from a receipt. Neither passwords,
hashes, tokens nor connection secrets may be supplied as approval/operator metadata.

The CLI only recovers an EXISTING ACTIVE ADMIN. It rejects a missing, inactive or
non-ADMIN target; it does not create, promote, reactivate or edit unrelated users.
No POS, Finance, Inventory, Procurement or Purchase Order records are changed.

Inside the existing access-management advisory lock and one database transaction,
the service rechecks applicable database identity, target role/active status and
expected version, replaces the hash, increments credentialsVersion exactly once,
clears temporary recovery state and creates the immutable receipt. Every credential
and receipt mutation rolls back together if any check or insert fails. Existing
AuditLog records and attribution are unchanged.

## Interrupted responses and retries

An operation UUID binds the original non-secret intent and verified target/operator
context. An already-committed identical invocation returns authoritative status
only, with no password reapplication, second version increment or duplicate receipt.
Changed intent is rejected even if the recovered credential has since changed.
Identical committed status remains inspectable if the target is later deactivated
or demoted; a new recovery still requires an existing active ADMIN.
The implementation stores no password or password-derived fingerprint for retries.

If the result is interrupted or uncertain, inspect the operation's safe status with
the same reviewed CLI and original context before any new recovery. A saved receipt
is evidence of that committed operation, not a guarantee that its credential is
still current. An absent receipt is not authorization to start a different recovery.
If replacement is needed, obtain separate authorization and a new operation UUID
against the currently inspected version. Do not delete receipts, disable triggers,
decrement versions or reuse bootstrap to force another attempt.

## After a committed recovery

1. Retain the safe receipt/status and independent approval/host-access evidence in
   the owner's external audit location. Record no credential material there.
2. Deliver the password privately through the approved password-manager handover.
   Verify HTTPS login, expected ADMIN access and logout as the recovered ADMIN.
3. Verify an old signed session fails its next authentication/authorization check.
   Already-authorized requests may have completed before version replacement; the
   service does not retroactively cancel work. The maintenance drain limits this
   window. Throttle counters and the session-signing secret are not reset.
4. Reopen ingress only after the approved verification and maintenance exit steps.
   Handle any failed verification under a separate owner decision; never restore a
   previously used credential or weaken identity checks automatically.

## Audit immutability and its boundary

Migration `20261016000000_emergency_admin_recovery` is additive migration 21. It adds
only EmergencyAdminRecovery, its checks, restrictive target FK, inspection index
and append-only triggers. UUID is the primary key with no generated default. All
evidence fields are required, nonblank and bounded; resultingVersion must equal
expectedVersion + 1 without overflow. createdAt defaults to the database timestamp.
The CLI service explicitly captures PostgreSQL's clock inside its transaction.
That transaction uses UTC for driver timestamp serialization; it does not change
the database default timezone or Asia/Jakarta business-date semantics.

Normal DML UPDATE/DELETE is rejected by row triggers. TRUNCATE is rejected by a
statement trigger, including an empty-table TRUNCATE. A database owner, superuser
or DDL-capable principal can alter/drop/disable this protection or insert fabricated
evidence outside the reviewed CLI. This is not proof against those principals.
Separate owner/migration access from runtime DML access, secure credentials and
retain independent external evidence. No existing AuditLog protection is weakened.
Append-only enforcement protects receipts after insertion; it does not authenticate
their contents. A principal with receipt INSERT or User UPDATE access can bypass
the CLI's evidence or credential workflow. Restricted maintenance/runtime grants
and independent audit retention remain owner decisions before operational use.

## Isolated acceptance

Use only newly created disposable databases through the repository runner:

```powershell
node --import tsx --conditions=react-server prisma/run-phase4b-tests.ts --focused
node --import tsx --conditions=react-server prisma/run-phase4b-tests.ts
node node_modules/prisma/build/index.js validate
npm.cmd run typecheck
npm.cmd run lint
git diff --check
```

The focused and full runs must each finish with exit 0, no failures and no
unexplained skips. Verify all 21 migrations from a fresh database, bootstrap
compatibility, concurrent/stale attempts, committed/changed-intent retries,
lost-response inspection, audit-insert rollback, SQL UPDATE/DELETE/TRUNCATE
rejection, exact password verification, subsequent old-session rejection and no
unrelated business-record mutations. The runner drops and verifies removal of only
the databases it created. Preserve `.env`, `next.config.ts`, the Git index and all
20 existing migrations. Automated tests do not authorize operational execution or
establish real device, hosting, operator-access or backup acceptance.
