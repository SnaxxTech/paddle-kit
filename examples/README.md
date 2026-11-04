# Starters

Copy one folder into a Next.js app (App Router) and set the environment variables (main README, "Environment
variables", plus `DATABASE_URL` and `CRON_SECRET`). Then run `migrate()` from `lib/migrate.ts` once before the first
deploy. `tests/starters.test.ts` runs every file here as written, on real Postgres.

| Folder | Sells | Files beyond the four pieces |
|---|---|---|
| `subscription/` | a plan (`pro`) | none |
| `unlock/` | a lifetime licence (`lifetime`) | `lib/fulfilment.ts`, `lib/email.ts`, outbox route |
| `credits/` | packs of 100 credits (`pack`) | `lib/fulfilment.ts`, `lib/email.ts`, `lib/credits.ts`, outbox route |

Defaults you may change:

- **postgres-js** in `lib/db.ts`: it runs on Node (Vercel) and Cloudflare Workers. On Workers, create the client per
  request (a socket cannot cross requests). For pg or the Neon Pool use `fromPg`, for PGlite `fromPglite`.
- **Receipts** go out right after the payment commits (`lib/outbox.ts`); the outbox route is an **hourly** backstop.
- **Crons** (`vercel.json`): recovery and outbox, both hourly at minute 0, so they share one database wake-up (Vercel
  Pro; the Hobby plan runs crons once a day, which is still enough). Never more often than hourly on a free-tier database:
  on Neon's free plan a 5-minute cron uses about 182 CU-hours a month against 100 included, and the database is
  suspended until the next month (main README, "Free-tier databases").
- **`lib/email.ts`** logs the receipt: put your email provider's call there, keyed on `item.id`.
- Imports are relative, so a folder works without a path alias.
