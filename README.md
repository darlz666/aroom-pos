# AROOM POS

A touchscreen-first point-of-sale project for AROOM Coffee Bar, built with Next.js, TypeScript, and PostgreSQL for a single outlet and register.

## Requirements

- Node.js
- pnpm
- PostgreSQL

## Local setup

Copy `.env.example` to `.env` and configure `DATABASE_URL` for your local development PostgreSQL database. With PostgreSQL running, run:

```bash
pnpm install
pnpm prisma generate
pnpm prisma migrate deploy
pnpm db:seed
pnpm dev
```

The app runs at [http://localhost:3000](http://localhost:3000).

## Development menu seed

The seed contains the confirmed AROOM menu: **4 categories and 23 products**. Categories are Signature, Americano Series, Coffee & Drinks, and Food & Snacks, in that display order. All seeded categories are active; all seeded products are active and available. Prices are integer rupiah, defined with stable IDs in `prisma/seed-menu.ts`.

The seed is development-only and refuses `NODE_ENV=production`. Use only a development `DATABASE_URL`. Reruns restore the seeded menu values in one transaction without duplicates, preserving unrelated rows and product creation timestamps. No users or transaction data are seeded or deleted.

Run the integration test against the migrated development database:

```bash
pnpm exec tsx --test prisma/seed-menu.test.ts
```

The test rolls back its database changes.
