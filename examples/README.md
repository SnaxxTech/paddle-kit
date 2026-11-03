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
- **Crons** (`vercel.json`): recovery hourly, outbox every 5 minutes (Vercel Pro; the Hobby plan runs crons once a
  day). On Neon's free plan a 5-minute cron keeps the compute awake: about 180 CU-hours a month against 100 included.
  Slow it to hourly there if receipts may wait.
- **`lib/email.ts`** logs the receipt: put your email provider's call there, keyed on `item.id`.
- Imports are relative, so a folder works without a path alias.
