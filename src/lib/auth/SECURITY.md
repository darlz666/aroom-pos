# Phase 4B-2 security and recovery

Implementation is separate from operational deployment. Do not access the old
`aroom_pos`, run development seeds, or invoke bootstrap against existing records.
The clean-start chain now contains 20 migrations, including the additive candidate
`20261015000000_authentication_hardening`. No earlier migration changes are required.

## Initialization and compatibility

The candidate adds User.credentialsVersion (positive, default 1), mustChangePassword
(default false), and temporaryCredentialExpiresAt (nullable). A check requires the
flag and expiry presence to agree. Existing hashes and account status are preserved.
CredentialRecovery audit rows double as unique UUID operation receipts and cannot
be updated or deleted. No password, credential digest, token or delivery payload is
stored in audit details. No recovery service or external delivery infrastructure.

First ADMIN bootstrap dynamically verifies every migration name and checksum, and
enumerates the generated model tables; the new complete 20-migration chain is used
without weakening empty-database or identity checks. Its hidden password policy
remains 20–128 code points and at least eight distinct characters. Regular new
passwords use 12–128 code points. Login preserves legacy shorter passwords until
explicit replacement. Neither accepted passwords nor existing hashes are normalized.

Deploying the new token contract invalidates all legacy cookies, even though
credentialsVersion defaults to 1. Users must log in again. Schema must be applied
before starting the matching application version, under separate owner approval.
Do not roll back to a version that accepts versionless cookies after deployment.

## ADMIN handover

Access Management links the ADMIN's own password-change screen. Reset controls
reject ADMIN and inactive targets; the server independently enforces this policy.
Inspect status, enter the ADMIN's current password, then explicitly issue a new
temporary credential. The server generates 24 random bytes (192 bits) with Node's
cryptographic generator. Only the original successful response contains its text.
It expires 30 minutes after hashing completes; time checks use the server clock.

Use a private, supervised handover. Closing, refreshing or hiding the display
permanently removes its local view. Copy occurs only on a deliberate button press;
the owner is responsible for removing clipboard contents after handover. There is
no email, SMS or WhatsApp delivery and no browser persistent credential storage.
The employee must replace it before any normal page or action is authorized.
If login or a restricted session expires, a newly authorized reset is required.

After lost responses, inspect the reset's status. Identical retries return current
status without another password/hash/version increment/audit. New operation IDs
require fresh reauthentication and an expected current version; competing versions
have one winner. Status may be applied, superseded or absent, with current normal,
temporary or expired credential state. The UI permits explicit reissue only after
status inspection. After page reload the owner can inspect the account's current
state and explicitly issue again; plaintext cannot be recovered. Browser memory
contains only the currently displayed credential, not a persistent retry secret.

## Session guarantees

The JWT has userId, credentialsVersion, issuer, audience, issued-at and expiry.
Signature, algorithm, exact claim set and 12-hour lifetime are verified. Each
protected request loads the current active user and matches the version. Database
temporary state and its 30-minute expiry are checked even for an unexpired JWT.
Normal guards redirect restricted identities to /change-password before work.
Only its dedicated page/action and logout accept restricted identities.

Reset/change/access mutations share the access-management advisory lock. ADMIN
reauthentication and target authorization occur inside the transaction after this
lock. Replacement increments the version, clears temporary state and audits in one
transaction. Deactivation (including the existing archive path) increments once;
reactivation cannot revive old cookies. Roles remain freshly loaded.

Login signs the version from the same row snapshot whose hash passed verification.
A reset racing verification may result in a rejected old-version cookie; it cannot
silently upgrade old-password authentication to the new version. Sessions already
authorized before reset may finish in-flight work. This design does not cancel
transactions retroactively. Logout expires the current browser cookie; copied
cookies and other devices are not revoked by ordinary logout.

## Remaining go-live dependencies

- Emergency recovery for a locked-out/sole ADMIN needs separate design and owner
  approval. Bootstrap cannot be reused for account recovery.
- Phase 4B-2B-1 adds account admission throttling and offline screening below.
  Trusted client-IP enforcement remains disabled. Cloudflare ingress/origin access,
  broad password-spraying and volumetric attack controls still need verification.
- Verify real HTTPS cookies, Android/browser form behavior and private handover
  with the owner. Automated tests do not establish physical-device acceptance.

## Verification

Use `node --import tsx --conditions=react-server prisma/run-phase4b-tests.ts --focused`
and then the same command without `--focused` for a complete clean run. The focused
selection includes authentication, users, recovery UI, bootstrap and categories.
Only new locally generated disposable databases are migrated; identity, migration
count and cleanup are checked. Per-file TAP results are saved outside the repository.
Run Prisma validation, TypeScript, repository ESLint and git diff --check as well.

## Phase 4B-2B-1 account admission

PostgreSQL AuthThrottle reserves 10 LOGIN admissions per normalized identifier and
5 REAUTH admissions per actor in independent 15-minute windows. REAUTH is shared
by ADMIN reset and voluntary/mandatory password replacement. Successful requests
also consume admissions; failures and uncertain responses cannot replenish them.
The admission statement commits before the credential transaction/global access
lock. Actor authorization is checked before reauthentication admission and again
inside the credential transaction. No client-provided operation UUID resets quota.
Denied attempts neither increment the count nor extend expiry. Use database time.

HMAC keys use dedicated server-only AUTH_THROTTLE_HMAC_SECRET, never SESSION_SECRET
as fallback. Require canonical padded standard base64 encoding 32–64 bytes generated
by a cryptographic random generator. Reject absent/empty values, whitespace,
noncanonical/invalid encoding, short/oversized bytes, fewer than 16 distinct byte
values, repeated byte sequences, sequential bytes, and direct reuse of the session
secret (encoded string or UTF-8 bytes). These weak-pattern checks are not a proof of
entropy: operators must use a CSPRNG, never a human-chosen phrase. Errors expose no
secret material. No NEXT_PUBLIC config or hardcoded fallback exists. Tests inject
independent random secrets into child process environments only; no .env changes.
No identifier, IP address, password or token is stored in the counter table. All
application instances sharing the database must receive the identical dedicated
secret through protected server configuration. Existing session validation and POS
operations do not require this secret; login and sensitive reauthentication do.
No in-memory enforcement, role exemption or header-derived source bucket exists.

Rotation is a separate owner-approved operation, never automatic. Record reason,
approver and maintenance window without secret values. Stop admission traffic and
drain in-flight auth requests on every instance; retain counters and backups. Wait
at least the full 15-minute admission window after the last admitted request so a
new namespace does not prematurely replenish active quotas. Generate a fresh
independent key through the approved secret manager, distribute atomically to all
stopped instances, restart and verify a synthetic admission consistently across
instances before reopening traffic. Never mix old/new keys, silently fall back,
delete counters or print the key. If verification fails keep admission closed and
restore the prior configuration consistently under the same approval. Emergency
rotation sooner than 15 minutes requires explicit owner acceptance of resetting
attempt history plus ingress restriction; this task authorizes neither procedure.
HMAC rotation alone does not invalidate JWT sessions or rotate SESSION_SECRET.

Generic login errors cover wrong passwords and exhausted admission. Recovery
returns UNAVAILABLE without counter details, and status inspection remains usable.
On false positives, wait at most 15 minutes after the first admitted attempt.
Existing sessions are not revoked by throttling; no employee can exhaust a shared
IP counter because there is no such counter. Deliberately attacking a known login
can still temporarily deny that account; this is not protection against all DoS.
Database/secret failures fail closed for authentication; logout is independent.

Expired rows are reused on the next admission. pruneAuthenticationAttempts is a
bounded maintenance helper deleting at most 500 rows expired more than 24 hours
ago; it does not run a scheduler or modify infrastructure. An approved production
maintenance schedule and table-growth monitoring are deployment prerequisites.
Unknown-identifier flooding remains an ingress/capacity concern until configured.

All new credential hashing uses the pinned local corpus described in
password-blocklist.README.md: 150,000 raw and normalized-unique source candidates,
150,007 effective values including local defaults, without duplicate padding.
Login does not apply the new-password blocklist and makes no corpus filesystem
reads. New issuance validates the checksum once on initial load per process.
Include and validate that asset in the eventual deployment artifact. No production
hardware is selected; the implementation has no STB/ARM-specific assumptions.
