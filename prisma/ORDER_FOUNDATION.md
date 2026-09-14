# Order database foundation (3B)

The preflight on the local development database found zero Orders, OrderItems,
and Payments. The new migration relies on empty Order/OrderItem tables and checks
that assumption under table locks in an explicit transaction. It aborts on a
populated target rather than deleting rows, manufacturing original requests, or
renumbering receipts. A populated target needs a separately reviewed preserving
backfill. Previous migrations are unchanged.

Prisma represents revision (default 1), the required UUID createIdempotencyKey
with global uniqueness, and the required text createRequestFingerprint. No
automatic key/fingerprint defaults: the future service must retain the submitted
key and compute a deterministic fingerprint from the normalized ORIGINAL request.
Do not include credentials, session/token data, or expose these fields in POS DTOs.
The immutable fields stay with the order after shift closure so future authorized
replay recovery can query the key without requiring that shift to remain OPEN.

CHECK constraints, the create-request immutability trigger/function, and the
standalone bigint order_number_seq live in migration SQL, not Prisma schema
syntax. Preserve them in future migrations; schema push is not a substitute.
The sequence starts at 1, does not cycle/reset daily, and permits gaps. Future
server code will format its values as AR-000001 etc.; no formatting/default is
implemented here. Sequence values are not financial truth.

Existing order-number uniqueness and shift/status lookup indexes remain useful.
The only new index is global idempotency-key uniqueness; another shift/status
index is unnecessary for this single-register MVP. Snapshot fields are already
sufficient. Payment fields and indexes are unchanged.

Future services must enforce Shift -> Order -> Payment locking, revision checks
and exactly one increment per successful mutation, nonempty orders, total equals
item sums, terminal immutability/no normal deletes, and authenticated ownership.
CHECKs enforce row validity, not allowed transitions or successful payment evidence.
Existing snapshots cannot silently follow menu changes. Payment preparation must
block on price drift for explicit review/reprice, never silently alter prices.
No services, actions, cart/UI, payment, or order-number generation are implemented.

Run `node_modules\.bin\tsx.cmd --conditions=react-server --test prisma/order-integrity.test.ts`.
Fixtures use a new CLOSED shift (database-only tests), never modify real rows,
and roll back. Sequence calls consume two values even on rollback; never reset
the live sequence to clean up test gaps. Run database test files sequentially.
