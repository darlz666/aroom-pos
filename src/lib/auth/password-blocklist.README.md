# Offline password screening, policy v2

Vendored from SecLists (MIT; see password-blocklist.LICENSE), revision
`3a5f62f0e18a1b8a36b25399aff0077f3706e5af`:
https://github.com/danielmiessler/SecLists/blob/3a5f62f0e18a1b8a36b25399aff0077f3706e5af/Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt

Pinned upstream SHA256:
`424a3e03a17df0a2bc2b3ca749d81b04e79d59cb7aeec8876a5a3f308d0caf51`.
Upstream contains 999,999 nonempty rows, 999,996 raw-unique candidates and 966,730
NFC/lowercase-unique candidates. MIT redistribution notice is retained unchanged.

Reproducible selection: decode upstream UTF-8; split on CRLF/LF; discard empty
lines; traverse source order, keeping the first original row for each previously
unseen `row.normalize("NFC").toLowerCase()` value; stop after 150,000 selections.
Write original selected rows separated by LF with one final LF. No generated
padding, repeated candidates, runtime downloads or staff-derived data are added.
All selected corpus rows come from the public pinned source; no AROOM staff
credentials were collected or consulted. This cannot establish that nobody has
ever independently chosen a password also present in a public common-password list.

Vendored raw rows: **150,000**. Raw unique: **150,000**. Normalized unique:
**150,000**. Final effective set including the existing eight local candidates:
**150,007** (one local candidate already appears in the selected corpus).
Vendored SHA256 (UTF-8, canonical LF):
`29ce82aa582156d61282f64f4b5e89c8619ccbebd879b5a016cf6dddd2ad81c0`.
The small explicit AROOM/default-password supplement lives in password-screening.ts.

This supersedes v1's 99,999-row source (SHA256
`1472aafa2561df5e3293aee252aee3ca660c12b399a283cf808bb01b39be388b`),
which had only 96,524 effective values including the supplement and failed the
100,000-effective-candidate security gate.

Compare whole strings using NFC and Unicode lowercase only. Do not trim, remove
accents, reject dictionary substrings or transform accepted password bytes. New
human-chosen credentials and random temporary credentials use the same local list.
No network requests, credential digests or passwords leave the application.
This finite list does not detect every compromised password.

Ship this server-only asset at src/lib/auth/password-blocklist.txt relative to the
application working directory, including in any future packaged deployment.
Verify its checksum and run screening tests on the actual release artifact.
Missing/corrupt assets fail closed for new credentials; login verification is
independent of screening. Successful loading is cached for the process lifetime.
Restart on a reviewed corpus update. Never fetch replacements at runtime.

Updates require owner review of provenance/license, checksum, count and regression
tests. Preserve the license and review the policy at least every six months.
