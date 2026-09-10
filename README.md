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

## Authentication utilities

Milestone 2D2 provides password and signed session token utilities only. Passwords
must contain 12–128 Unicode code points; spaces are preserved and no composition
rules apply. Hashing uses Argon2id with library cost defaults and automatic salts.
Cryptographic modules require the Node.js server runtime and import `server-only`.

Before using session utilities, configure `SESSION_SECRET` in your untracked `.env`
or production secret configuration with a strong random secret generated from at
least 32 random bytes (for example, encoded as base64). Never commit it or expose
it through `NEXT_PUBLIC_*`. Signing and verification read the secret lazily;
imports and builds do not require it. Missing/invalid configuration throws a
generic configuration error, while invalid tokens return `null`.

HS256 tokens contain only `userId`, `iat`, `exp`, and fixed application issuer and
audience claims, with a 12-hour lifetime. Verified identity does not establish
authorization: future protected requests must load user role and active status
from PostgreSQL. Cookie options are provided without setting or deleting cookies.

Run the isolated utility tests without a database or configured session secret:

```bash
pnpm exec tsx --conditions=react-server --test src/lib/auth/auth.test.ts
```

The test-only `react-server` condition enables the `server-only` package in Node.

## Development menu seed

The seed contains the confirmed AROOM menu: **4 categories and 23 products**. Categories are Signature, Americano Series, Coffee & Drinks, and Food & Snacks, in that display order. All seeded categories are active; all seeded products are active and available. Prices are integer rupiah, defined with stable IDs in `prisma/seed-menu.ts`.

The seed is development-only and refuses `NODE_ENV=production`. Use only a development `DATABASE_URL`. Reruns restore the seeded menu values in one transaction without duplicates, preserving unrelated rows and product creation timestamps. No users or transaction data are seeded or deleted.

Run the integration test against the migrated development database:

```bash
pnpm exec tsx --test prisma/seed-menu.test.ts
```

The test rolls back its database changes.
