# Create Order backend (3C)

`createOrder(db, actor, input)` is an internal server-only service. Future server
entrypoints must authenticate the active user before supplying the actor. The
authenticated actions added in 3E are documented below; there is no UI or payment
implementation here.

The only accepted request fields are `createIdempotencyKey` (UUID), `orderType`
(`DINE_IN` or `TAKEAWAY`) and `items` (`productId`, numeric integer `quantity`).
Unknown fields are rejected. There is no order-level note in the current schema;
item customization is outside this milestone. UUIDs use canonical lowercase.
Duplicate product IDs merge, quantities must be 1–99 after merging, and there
must be 1–100 unique lines. Lines sort by product ID. Node SHA-256 hashes a
deterministic JSON representation of normalized type and lines, excluding the
key and all server-derived facts.

Replay lookup precedes open-shift discovery. Matching creator and fingerprint
return committed snapshots, even after menu changes or historical shift closure.
Other creators or changed intent receive only `IDEMPOTENCY_CONFLICT`. Replay
does not allocate a number, query products, rebuild items or insert an audit.

New creation uses Read Committed and discovers the single active shift on the
server. It locks that row by ID using the shared shift helper, then rechecks the
key and authorizes OPEN status/ownership under the lock. Lock order remains
Shift → Order → Payment; creation has no existing order to lock and touches no
payment. ADMIN assistance retains the shift owner and records ADMIN as creator.
The lock remains held until commit, so an earlier create blocks closure with its
UNPAID order, while an earlier close makes creation reject. All future writers
must preserve this discipline.

One product query loads current name, price, active and available flags. Every
product must exist and be eligible. Server prices generate immutable receipt
snapshots. Integer IDR arithmetic checks multiplication and sum against
2,147,483,647 before calculating. No automatic repricing is performed.

After validation, `nextval('order_number_seq')` runs inside the transaction and
formats as `AR-000001`, growing beyond six digits naturally. Rollback may leave
gaps; the sequence is never reset and is not accounting truth. Order (UNPAID,
revision 1), nonempty nested items and one `ORDER_CREATED` audit commit atomically.
The audit allowlists business facts and snapshots; no key, fingerprint, session,
credentials, raw request or notes are copied. The result similarly omits internal
request fields and translates snapshots to productName/unitPrice.

The global PostgreSQL key constraint is the final race defense. On a unique
failure, recovery queries run outside the rolled-back transaction and apply the
same replay rules. Unexpected database/connectivity errors become `CREATE_FAILED`
without raw details. A failed response can mean commit uncertainty: callers must
retry with the same key and original intent, never silently queue a new request.

Run unit/service tests with `node_modules/.bin/tsx.cmd --conditions=react-server
--test src/lib/orders/*.test.ts`. Run `prisma/create-order.test.ts` with the same
flags against a local, idle development database. Run database test files
sequentially. Integration tests use generated fixture identities, remove only
those fixtures, compare all affected development rows before/after, and report
the final sequence value without resetting it.

# Edit and Cancel Order backend (3D)

`editOrder(db, actor, input)` and `cancelOrder(db, actor, input)` are internal
server-only services, exposed through the authenticated actions below. Only `UNPAID`
orders are mutable; `PAID` and `CANCELLED` are terminal and immutable.

Both requests require the current integer `expectedRevision`. A successful edit
or cancellation increments `revision` exactly once. A stale value returns
`REVISION_CONFLICT` without mutation or audit. Mutations lock resources in the
order `Shift -> Order -> Payment`, and authorization uses the Order's persisted
`shiftId`. `Order.cashierId` remains the original creator and `Shift.cashierId`
remains the shift owner; the editing or cancelling actor is recorded in audit.

`ADD_ITEM` reads the current authoritative Product and creates a new name/price
snapshot. `SET_QUANTITY` preserves the existing snapshot; increasing quantity
revalidates current Product eligibility, while decreasing quantity is allowed
when the Product is unavailable or inactive. `REMOVE_ITEM` cannot remove the
final persisted line. Totals are recalculated by the server from persisted
items. A `PENDING` or `SUCCEEDED` Payment blocks edit and cancellation;
`FAILED`, `EXPIRED`, and `CANCELLED` attempts alone do not.

Cancellation preserves items, total, original creator, and shift. Its optional
trimmed reason is stored only in `ORDER_CANCELLED` audit details. Audit writes
are atomic with the mutation. Milestone 3D itself did not include server actions;
Milestone 3E now provides authenticated server actions. POS UI, payment processing,
and a repricing workflow remain unimplemented.

# Authenticated Order actions (3E)

`actions.ts` exports only async Next.js Server Actions: `createOrderAction(input)`,
`editOrderAction(input)`, and `cancelOrderAction(input)`. Each calls `requireUser()`
to obtain the active database user for every invocation. Both ADMIN and CASHIER
reach the services, where ownership and all business rules remain enforced.

Inputs are `unknown` and pass unchanged to the existing strict service validators.
Use the create and mutation request shapes documented above. Client actorId,
userId, cashierId, role, shiftId, monetary fields, and other unknown fields are
rejected, including unexpected nested item/operation fields. Actions do not
strip fields, generate keys, discover shifts, reprice, retry, or write audits.

Success returns `{ success: true, order }`. The explicit DTO allowlist contains
id, orderNumber, status, revision, shiftId, cashierId, orderType, total, createdAt
(ISO string), and items (id, productId, productName, unitPrice, quantity,
lineTotal). Create additionally includes `order.replayed`. Internal request
keys/fingerprints, payment records, and audit details are never returned.

Failure returns `{ success: false, code, error }` with fixed Indonesian messages
for all OrderError codes. Unexpected errors, including authentication database
failures, use the operation's CREATE_FAILED, UPDATE_FAILED, or CANCEL_FAILED
code without raw details. Next.js authentication redirects propagate normally.
Creation uncertainty requires the same idempotency key and original intent;
mutation uncertainty and revision conflicts require reloading and reviewing the
persisted order before retrying. No action automatically retries a mutation.

Run `node_modules/.bin/tsx.cmd --conditions=react-server --test
src/lib/orders/actions.test.ts`. These tests use real session verification and
database user lookup with isolated mocks, real service validation for rejected
inputs, and controlled service responses for DTO/error boundary coverage. They
do not connect to a database or consume order sequence values.
