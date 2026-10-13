# Phase 4B-2 security and recovery

Implementation is separate from operational deployment. Do not access the old
`aroom_pos`, run development seeds, or invoke bootstrap against existing records.
The clean-start chain now contains 19 migrations, including the additive candidate
`20261014000000_credential_recovery`. No earlier migration changes are required.

## Initialization and compatibility

The candidate adds User.credentialsVersion (positive, default 1), mustChangePassword
(default false), and temporaryCredentialExpiresAt (nullable). A check requires the
flag and expiry presence to agree. Existing hashes and account status are preserved.
CredentialRecovery audit rows double as unique UUID operation receipts and cannot
be updated or deleted. No password, credential digest, token or delivery payload is
stored in audit details. No recovery service or external delivery infrastructure.

First ADMIN bootstrap dynamically verifies every migration name and checksum, and
enumerates the generated model tables; the new complete 19-migration chain is used
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
- No application login/reset reauthentication throttling or common-password
  screening exists. Infrastructure controls are unverified. These remain security
  blockers for go-live until separately addressed and accepted; no Redis, delivery
  provider or speculative infrastructure has been introduced.
- Verify real HTTPS cookies, Android/browser form behavior and private handover
  with the owner. Automated tests do not establish physical-device acceptance.

## Verification

Use `node --import tsx --conditions=react-server prisma/run-phase4b-tests.ts --focused`
and then the same command without `--focused` for a complete clean run. The focused
selection includes authentication, users, recovery UI, bootstrap and categories.
Only new locally generated disposable databases are migrated; identity, migration
count and cleanup are checked. Per-file TAP results are saved outside the repository.
Run Prisma validation, TypeScript, repository ESLint and git diff --check as well.
