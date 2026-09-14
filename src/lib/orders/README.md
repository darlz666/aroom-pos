# Create Order backend (3C)

`createOrder(db, actor, input)` is an internal server-only service. Future server
entrypoints must authenticate the active user before supplying the actor. There
is no server action, UI, edit/cancel operation or payment implementation here.

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
