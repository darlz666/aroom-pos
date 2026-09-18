# Stock Management Foundation — Milestone 7B

`Ingredient` owns the one shared stock balance. The existing `Product` optionally
references one `Recipe`; each `RecipeItem` references an ingredient once. For
example, 12 L of oatmilk is 12000 ml on one ingredient. Three recipes can refer to
100, 150 and 120 ml of that ingredient without splitting or changing its stock.

This module is a domain/database foundation, with no UI, routes, Server Actions,
CRUD services, stock writers, or changes to authorization. Inventory roles still
have their restricted landing. Existing POS, order snapshots, payments, printing,
and shifts do not import this module.

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
  or pcs. Null is unknown; zero is known zero. There is no cost calculation or
  rounding, recipe HPP field, or second selling price model.
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
canonical unit, optional source type/UUID pair, actor, and timestamp. Source fields
are correlation metadata until source workflows are designed; they are not a
foreign key, proof of payment, or an idempotency mechanism.

SQL triggers reject movement updates and deletes. Foreign keys restrict deleting
referenced ingredients/actors/products. Use active flags for retirement. The
foundation deliberately does not mutate balances when inserting a movement.
Future stock workflows must calculate balances server-side, serialize concurrent
changes, deduplicate retries, and insert history with the balance change in one
transaction. Corrections must append new movements. Use existing AuditLog for
future sensitive metadata mutations rather than introducing another audit system.

## Verification and migration

Generate Prisma Client and deploy the additive migration through the normal
deployment process. It creates only new tables/types/constraints/triggers, without
backfilling or updating existing POS data. Do not use `db push`: SQL checks,
expression indexes, and immutability triggers live in the migration.

```sh
pnpm exec prisma generate
pnpm exec tsx --test src/lib/inventory/domain.test.ts
pnpm exec tsx prisma/run-access-tests.ts
pnpm lint
pnpm typecheck
```

The existing integration runner creates and removes a disposable local PostgreSQL
database, applies all migrations, and runs all repository regressions. Inventory
database tests roll back their fixtures, including immutable movement records.
The runner requires a local DATABASE_URL with database-creation permission.
