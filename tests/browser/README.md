# Isolated real-browser acceptance

Install dependencies with the repository's pnpm version. Installed Chrome is
used headlessly; no bundled browser download is required.

Provide `AROOM_E2E_CONTROL_URL` explicitly: a local PostgreSQL connection whose
database is `postgres`. The runner does not load dotenv and refuses application
database targets. Run `pnpm test:e2e`. Never invoke Playwright directly against
an existing application; configuration requires the runner's verified context.

The runner creates a unique disposable database, verifies its actual identity
before migration/seeding/startup/tests, checks all 22 migration names/checksums,
and supplies its URL explicitly to both Prisma and the loopback-only Next server.
It uses catalog prices from `prisma/seed-menu.ts`, random test credentials and
synthetic stock recipes (not claimed operational recipes). Output, screenshots,
and failure traces go to a unique OS temporary directory. The server and database
are removed on normal success or failure. If forcibly terminated, inspect the
printed database name and process before performing separately verified cleanup.

The browser test covers real login, direct Admin-route denial, category tabs,
two differently customized beverage units, unlabeled food, server-saved CASH
checkout, repeated touch submission, and retry after the server commits but its
response is dropped. It checks saved history/COPY previews after refresh, honest
simulations, expired-session rejection, and offline history reads/recovery.
Finance/daily totals are checked using the existing server services against the
browser-created transaction; this is not a separate Finance UI acceptance test.

Database assertions use `database-probe.ts` through the existing tsx loader in a
separate guarded process. This avoids Playwright's incompatible transformation
of the generated Prisma client's `import.meta`, without editing that client or
application code. The probe never loads dotenv and verifies actual identity
before reading business tables.

Evidence includes `results.json`, `browser.log`, `server.log`, migration logs,
screenshots and measured layout findings, database totals, final data snapshots,
and `cleanup.json`. Playwright's automatically cleared artifacts directory is a
subdirectory, preserving the parent evidence logs. Cart layouts cover 1280x800,
1024x768, 800x1280, 768x1024 and reduced-height 800x700; payment/preview controls
are also exercised in landscape and portrait. Measured touch checks cover cart
buttons and payment confirmation, not every possible hit target.

Post-browser UI regression coverage also verifies saved customer and ordered
per-cup instructions directly in historical details, including after refresh.
Food/legacy lines without snapshots remain free of invented cup details.
Sugar/Ice/Cup options are measured against available select text space at all
cart viewports (with native-arrow space reserved), exercised and restored before
saving. Updated history and selector screenshots are retained alongside the
original receipt/COPY/payment evidence.

Viewport/touch emulation and reduced-height keyboard approximation do not prove
Android keyboard, PWA, Bluetooth, paper output or physical tablet usability.
Simulation must remain explicitly not physically printed. QRIS stays disabled.
