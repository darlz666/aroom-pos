# Stock Management Foundation — Milestone 7B

`Ingredient` owns the one shared stock balance. The existing `Product` optionally
references one `Recipe`; each `RecipeItem` references an ingredient once. For
example, 12 L of oatmilk is 12000 ml on one ingredient. Three recipes can refer to
100, 150 and 120 ml of that ingredient without splitting or changing its stock.

Milestone 7C adds supplier and Stock In backend services/Server Actions to the 7B
foundation. Active ADMIN and STOCK_MANAGEMENT may call them; CASHIER and FINANCE
may not. Milestone 7D adds `/inventory` and sends STOCK_MANAGEMENT there after
login. Existing POS, order snapshots, payments, printing, and shifts do not import
this module. See `src/app/inventory/README.md` for UI and recovery behavior.

## Data and validation

- `ingredientInput` trims required names, canonicalizes kg to g and L to ml,
  converts minimumStock, and validates active state. It rejects client balances
  and costs; database defaults initialize currentStock to zero. The SQL expression
  index prevents names duplicated by case or surrounding spaces, including
  inactive ingredients, using the same normalized-identity principle as logins.
  A duplicate insert reports Prisma `P2002`; a future mutation service must handle
  that conflict rather than inventing another stock record.
- `inventoryQuantity` validates stock/consumption values without clamping.
  `convertQuantity` implements only kg/g and L/ml conversion. `Decimal(18,3)` and
  Prisma Decimal preserve exact quantities; excess precision and overflow fail.
  Decimal strings are preferred at boundaries. Count quantities also use decimals
  so recipes can describe a portion of a count item.
- Ingredient base units are immutable. Both recipe and movement composite foreign
  keys require the ingredient's canonical unit. This prevents changing the meaning
  of existing quantities, cost, and history.
- `ingredientUnitCost` validates an optional integer rupiah cost per **one** g, ml,
  or pcs. Null is unknown; zero is known zero. Stock In snapshots its supplied
  cost per base unit, without updating Ingredient.unitCost or recipe HPP.
- `supplierInput` validates required name, optional text details, and active state.
  Supplier names follow the existing menu convention of nonunique display names.
- `recipeInput` validates IDs, positive quantities, supported units, and duplicate
  references. `validateRecipeReferences` requires actual Product and Ingredient
  records loaded by trusted server code, validates existence and compatibility,
  and normalizes quantities. It is a pure helper, not an authorized write API.
  Future writers must load those records and persist in their own guarded
  transaction; the database foreign keys also enforce references and units.

## Movement history

Movements contain a positive magnitude, direction given by type, resulting stock,
canonical unit, optional source type/UUID pair, actor, and timestamp. Receiving
sets sourceType to `StockIn` and sourceId to its receipt ID. A partial unique index
prevents multiple PURCHASE movements for the same receipt and ingredient. The
source pair remains correlation metadata, not a foreign key or proof of payment.

SQL triggers reject movement updates and deletes. Foreign keys restrict deleting
referenced ingredients/actors/products. Use active flags for retirement. The
foundation deliberately does not mutate balances when inserting a movement.
Stock In calculates balances server-side, locks ingredients in ID order,
deduplicates retries, and inserts history with the balance change in one
transaction. Future stock writers must follow the same ingredient lock order.
Corrections must append new movements; no correction workflow is included.

## Stock In and suppliers (7C)

`actions.ts` authenticates with `requireInventoryManager` in the existing auth
module. `service.ts` receives only a server-authenticated actor, reloads their
database role/active status, and holds the user row with FOR SHARE until commit.
Deactivated or demoted sessions fail on the next call. Stock permission does not
grant access to POS, reports, or user administration.

- `listSuppliersAction()` includes active and inactive suppliers.
- `createSupplierAction({ name, contact?, phone?, address?, active? })` reuses 7B
  validation. Names remain nonunique. Actual creation is audited transactionally.
- `updateSupplierAction({ supplierId, name, contact?, phone?, address?, active })`
  replaces metadata; omitted optional details become null. Explicit active state
  prevents accidental reactivation. Unchanged retries do not create audit entries.
  No delete action exists. On an uncertain supplier write, reload before retrying.
- `createStockInAction(input)` accepts the following shape. Generate the UUID key
  once for a delivery and retain it, receivedAt and the complete payload through
  retries. Quantity strings preserve exact decimals; costs are integer numbers.
- `getStockInAction(stockInId)` reads the committed receipt. DTOs expose quantities
  as decimal strings and dates as ISO instants, without internal fingerprints.
  The 7D detail also exposes the creator's name and the sum of saved line totals.
- `listIngredientsAction()` reads shared balances, minimums, canonical units and
  active state with exact server stock status: EMPTY at zero, LOW at/below minimum,
  otherwise AVAILABLE. This action does not create or change ingredients.
- `listStockInsAction({ cursor? })` reads 25 receipts per page, ordered by creation
  time/ID, with safe summaries and a nextCursor. It accepts no client actor/filter
  authority. These reads use the same existing service authorization.

```ts
{
  idempotencyKey: "<UUID retained across retries>",
  supplierId: "<existing supplier UUID>",
  receivedAt: "2026-09-18T09:00:00+07:00",
  notes: "Morning delivery",
  items: [
    { ingredientId: "<oatmilk UUID>", quantity: "12", unit: "L", unitCost: 20 },
    { ingredientId: "<beans UUID>", quantity: "1", unit: "kg", unitCost: 100 },
    { ingredientId: "<cups UUID>", quantity: "1000", unit: "pcs", unitCost: 200 }
  ]
}
```

The first line records 12000 ml and Rp240000. `unitCost` always means rupiah per
one canonical g/ml/pcs, never per input kg/L. Integer arithmetic rejects fractional
rupiah and totals above 2147483647, without rounding. Ingredient cost, product
prices, availability and recipes stay unchanged. Positive quantities obey 7B
Decimal(18,3) limits. A receipt accepts 1–100 distinct ingredients, rejecting
duplicate IDs, missing/inactive references, incompatible units and stock overflow.

The transaction creates an immutable StockIn with a generated `SI-<UUID>`
reference, name snapshots and items, then PURCHASE movements and stock updates.
Supplier FOR SHARE locks prevent retirement/renaming mid-receipt; ingredient FOR
UPDATE locks serialize concurrent receiving. Any failure rolls back every write.
StockIn's unique idempotency key and per-key transaction advisory lock make
simultaneous or later retries return the same receipt (`replayed: true`). A key
with different content or actor fails with `IDEMPOTENCY_CONFLICT`. A replay still
works after supplier/ingredient retirement, because it makes no new stock changes.

An interrupted request has uncertain status. Retry the exact payload with the
same key to recover the committed receipt or safely create it if it rolled back.
Never use a fresh key for an uncertain delivery. Actions hide infrastructure
errors as `UNAVAILABLE`; they report success only after transaction commit.
Printing and payments have no role in inventory receiving.

## Verification and migration

Generate Prisma Client and deploy the additive migration through the normal
deployment process. It creates only new tables/types/constraints/triggers, without
backfilling or updating existing POS data. Do not use `db push`: SQL checks,
expression indexes, and immutability triggers live in the migration.

```sh
pnpm exec prisma generate
pnpm exec tsx --test src/lib/inventory/domain.test.ts
pnpm exec tsx --test src/lib/inventory/stock-in-domain.test.ts
pnpm exec tsx prisma/run-access-tests.ts
pnpm lint
pnpm typecheck
```

The existing integration runner creates and removes a disposable local PostgreSQL
database, applies all migrations, and runs all repository regressions. Receiving
tests exercise concurrency, rollback after writes, retries, shared recipes,
permissions and immutable history. Their append-only fixtures are removed with
the disposable database; the older foundation tests roll back their fixtures.
The runner requires a local DATABASE_URL with database-creation permission.
