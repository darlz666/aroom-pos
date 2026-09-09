# AROOM POS Engineering Rules

## Product Context

AROOM POS is a single-outlet, single-register POS used primarily on an Android tablet at AROOM Coffee Bar.

Read SPEC.md before planning or implementing any feature.

SPEC.md is the source of truth for product behavior and scope.

## Scope Discipline

- Do not expand product scope without explicit approval.
- Do not implement deferred features unless explicitly requested.
- Keep every task narrowly scoped.
- Avoid speculative infrastructure.
- Prefer the simplest implementation that satisfies SPEC.md.

## Architecture

- Use TypeScript.
- Use a modular monolith.
- Keep one repository and one application deployment for MVP.
- Avoid microservices.
- Avoid Redis unless explicitly required later.
- Avoid message queues unless explicitly required later.
- Avoid unnecessary background infrastructure.
- Keep business rules out of UI components.
- Keep payment integrations behind clear module boundaries.
- Keep printing behind PrinterAdapter abstraction.

## Server Authority

The server is authoritative for:

- Prices
- Order totals
- Product availability validation
- Permissions
- Order state
- Payment state
- Payment finalization

Never trust client-calculated money values as authoritative.

## Money

- Currency is Indonesian Rupiah.
- Store money as integers.
- Example: Rp22.000 = 22000.
- Do not use floating point money calculations.
- No tax calculation.
- No service charge calculation.

## Time

- Business timezone is Asia/Jakarta.
- Reporting and business dates must use Asia/Jakarta semantics.
- Store timestamps consistently and convert appropriately for display/reporting.

## Orders

- Preserve product-name snapshots in OrderItem.
- Preserve unit-price snapshots in OrderItem.
- Menu changes must never modify historical receipts.
- Paid orders cannot be edited.
- Paid orders cannot be deleted.
- Paid orders cannot be cancelled through normal cashier actions.

## Payments

Payment state and order state must remain separate.

Prevent duplicate payment submissions.

Use database transactions when finalizing successful payments and paid orders.

A stale failed notification must never overwrite an already successful payment.

## Midtrans

- Never expose Midtrans Server Key to client-side code.
- Midtrans payment success must be verified server-side.
- Do not mark QRIS as paid from frontend callbacks.
- Do not allow cashier to manually mark QRIS successful.
- Webhook processing must be idempotent.
- Support delayed payment status reconciliation through backend provider lookup.
- Protect against duplicate successful payment recording.

## BCA EDC

For MVP:

- BCA EDC is manually operated.
- Cashier manually processes the amount on the physical terminal.
- Cashier confirms successful approval in POS.
- Do not implement direct POS-to-BCA-EDC integration unless explicitly requested later.

## Printing

Confirmed printer:

- EPPOS EP58M / RPP02N
- 58 mm
- Bluetooth
- Android tablet

Do not directly couple checkout/payment code to the printer.

Use PrinterAdapter.

Printing failure must never:

- Reverse payment
- Change a successful payment to failed
- Cancel a paid order

Allow retry and reprint.

## Authentication and Permissions

Roles:

- Admin
- Cashier

Enforce permissions on the server, not only in the UI.

## Database

Prefer a simple relational schema.

Use PostgreSQL.

Use database constraints where appropriate for:

- Unique order numbers
- Payment safety
- Webhook deduplication
- Relational integrity

Avoid premature schema complexity.

## UI / UX

Primary device: Android tablet.

Design:

- Landscape-first
- Touch-friendly
- Large tap targets
- Persistent cart
- Clear totals
- Minimal typing
- Obvious payment state
- Obvious printer/error state

Do not optimize the cashier workflow primarily for desktop.

## Connectivity

MVP is online-first.

Do not implement offline transaction synchronization unless explicitly requested later.

If connectivity is unavailable, fail clearly rather than silently queueing financial transactions.

## Code Quality

Before implementing:

1. Read SPEC.md.
2. Inspect existing repository.
3. Identify the smallest required change.
4. Explain the plan when requested.

After implementing:

- Run relevant lint.
- Run TypeScript typecheck.
- Run relevant tests.
- Inspect git diff.
- Report any failures honestly.

Do not hide failing checks.

## Change Discipline

- Keep changes scoped to the requested task.
- Do not refactor unrelated code.
- Do not rename unrelated files.
- Do not install unnecessary dependencies.
- Do not add infrastructure for hypothetical future features.
- Do not rewrite working modules unless necessary.

## Security

- Keep secrets server-side.
- Never commit credentials.
- Never log sensitive payment credentials.
- Validate all server inputs.
- Enforce authorization server-side.

## Completion Rule

A task is not complete merely because the code compiles.

Verify the requested behavior.

For financial workflows, specifically consider:

- Duplicate clicks
- Retries
- Interrupted requests
- Stale responses
- Repeated webhooks
- Printer failure
- Connectivity loss

If a requested behavior conflicts with SPEC.md, stop and point out the conflict before implementing it.
