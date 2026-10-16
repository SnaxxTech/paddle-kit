# paddle-kit

Drop-in billing layer for web projects that sell through **Paddle Billing** (v2, not Classic): verified webhooks, subscription state mirrored into your own Postgres, and one `hasAccess(userId, feature)` check.
Framework-agnostic core (Web-standard APIs only, no runtime dependencies), with adapters for Next.js, Hono and Express.

Not for in-app purchases in store-distributed mobile apps. Google Play and the App Store require their own billing for digital goods; Paddle covers web checkout only.

## Install

```bash
npm i github:SnaxxTech/paddle-kit#v0.1.0
```

`memoryStore` (`paddle-kit/memory`) is for tests and local development only: its failure log is unbounded and it is not shared across instances. Use `postgresStore` in production.

Optional peer dependencies, install only what you use: `@paddle/paddle-node-sdk` (reconcile), `@paddle/paddle-js` (client checkout), `hono`, `express`. Using `paddle-kit/express` also needs `@types/express` for its types.

## Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `PADDLE_ENV` | server | `sandbox` or `production`. Sandbox and live never mix. |
| `PADDLE_NOTIFICATION_WEBHOOK_SECRET` | server | The notification destination's secret key. Required: `createBilling` throws if it is missing or empty. `billing.config` never contains it. |
| `PADDLE_API_KEY` | `reconcile` only | `pdl_sdbx_...` for sandbox, `pdl_live_...` for production. A mismatch with `PADDLE_ENV` throws. Keys must carry the `pdl_sdbx_`/`pdl_live_` prefix; legacy unprefixed keys are rejected. |
| `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` | browser | `test_...` for sandbox, `live_...` for production. A mismatch throws in `createCheckout`. |

Production guard: `environment: 'production'` throws when `NODE_ENV` is set and is not `'production'`, unless you pass `allowProductionInDev: true`. Runtimes that do not define `NODE_ENV` (for example Cloudflare Workers) skip this guard.

## Run the migration

The package never runs DDL itself. Run it once per project, either way:

- apply `node_modules/paddle-kit/migrations/001_init.sql` with your migration tool, or
- import `MIGRATIONS` from `paddle-kit/postgres` (`{ name, sql }[]`) and execute each `sql`.

The migration is additive and creates four tables: `paddle_events`, `paddle_subscriptions`, `paddle_customers`, `paddle_failures`. It uses `CREATE TABLE IF NOT EXISTS`, which does nothing if your project already has a table with one of those names but a different shape. Check for existing tables of those names before migrating. Shipped migration files are never edited; later changes arrive as new numbered files.

Timestamps are stored at millisecond precision (Paddle sends microseconds). Two events for one subscription in the same millisecond resolve as "later delivery wins".

## Next.js (App Router) example

`lib/billing.ts`

```ts
import { Pool } from '@neondatabase/serverless';
import { createBilling } from 'paddle-kit/core';
import { postgresStore } from 'paddle-kit/postgres';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const billing = createBilling({
  environment: process.env.PADDLE_ENV === 'production' ? 'production' : 'sandbox',
  webhookSecret: process.env.PADDLE_NOTIFICATION_WEBHOOK_SECRET,
  store: postgresStore({ query: (text, params) => pool.query(text, params) }),
  entitlements: {
    pri_01abc: ['pro'],          // price id -> features it unlocks
    pri_01def: ['pro', 'team'],
  },
  pastDueGraceDays: 7,
  healthToken: process.env.PADDLE_HEALTH_TOKEN, // optional, see Monitoring
});
```

`app/api/paddle/route.ts`

```ts
import { createNextRoute } from 'paddle-kit/next';
import { billing } from '@/lib/billing';

export const { POST, GET } = createNextRoute(billing); // POST = webhook, GET = health (404 unless healthToken is set)
```

`components/UpgradeButton.tsx` (client component)

```tsx
'use client';
import { createCheckout } from 'paddle-kit/client';

export function UpgradeButton({ userId, email }: { userId: string; email: string }) {
  return (
    <button
      onClick={async () => {
        const checkout = await createCheckout({
          token: process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN!,
          environment: process.env.NEXT_PUBLIC_PADDLE_ENV as 'sandbox' | 'production',
        });
        checkout.open({ priceId: 'pri_01abc', userId, email });
      }}
    >
      Upgrade
    </button>
  );
}
```

Always open checkout through `createCheckout(...).open(...)`: it sets `customData.userId`, which is how a subscription is linked to your user. `open` throws if `userId` is empty.

`app/dashboard/page.tsx` (server component)

```tsx
import { billing } from '@/lib/billing';

export default async function Dashboard() {
  const userId = await getCurrentUserId(); // your auth
  const pro = await billing.hasAccess(userId, 'pro');
  return pro ? <ProDashboard /> : <UpgradePrompt />;
}
```

`hasAccess` is true when the user has a subscription that maps to the feature and is `active`, `trialing`, or `past_due` within `pastDueGraceDays`. A cancellation scheduled for period end stays `active` until Paddle flips it. `canceled` and `paused` grant nothing.

### Postgres clients

`postgresStore` takes `{ query }` of type `(text, params?) => Promise<{ rows }>`.

- `pg` `Pool#query`, `@neondatabase/serverless` `Pool#query` and PGlite `db.query` match directly. Wrap in an arrow (as above) so `this` stays bound.
- Neon's HTTP driver: use `neon(url, { fullResults: true }).query`. Calling `neon(...)` itself as `sql(text, params)` throws in `@neondatabase/serverless` v1+. **UNVERIFIED by us** (not run against a real Neon HTTP endpoint).

### SQLite (better-sqlite3)

`sqliteStore` takes `{ db }`, any object with `prepare(sql)` (returning `run`/`get`/`all`) and `exec(sql)`; `better-sqlite3` matches directly. Node only (not for edge runtimes). Run the migrations once at startup; they are `CREATE ... IF NOT EXISTS` on `paddle_*` tables, so re-running is harmless. Timestamps are stored as epoch milliseconds (INTEGER).

```ts
import Database from 'better-sqlite3';
import { createBilling } from 'paddle-kit/core';
import { SQLITE_MIGRATIONS, sqliteStore } from 'paddle-kit/sqlite';

const db = new Database('app.db');
for (const m of SQLITE_MIGRATIONS) db.exec(m.sql);

export const billing = createBilling({
  environment: 'sandbox',
  webhookSecret: process.env.PADDLE_NOTIFICATION_WEBHOOK_SECRET,
  store: sqliteStore({ db }),
  entitlements: { pri_01abc: ['pro'] },
});
```

### Checkout: several line items and Paddle.js events

```ts
import { createCheckout } from 'paddle-kit/client';

const checkout = await createCheckout({
  token: 'test_...',
  environment: 'sandbox',
  onEvent: (e) => console.log(e), // optional: every Paddle.js event (e.g. checkout.completed)
});
// One price:
checkout.open({ priceId: 'pri_01abc', userId: 'org_1' });
// Several line items (pass exactly one of priceId or items):
checkout.open({ items: [{ priceId: 'pri_base', quantity: 1 }, { priceId: 'pri_extra', quantity: 12 }], userId: 'org_1' });
// Extra custom data (e.g. an order id) comes back on the transaction; userId is always yours and cannot be overridden:
checkout.open({ priceId: 'pri_01abc', userId: 'org_1', customData: { order_id: 'ord_7' } });
```

## Hono

```ts
import { Hono } from 'hono';
import { paddleWebhook, paddleHealth } from 'paddle-kit/hono';
import { billing } from './billing';

const app = new Hono();
app.post('/paddle', paddleWebhook(billing));
app.get('/paddle', paddleHealth(billing));
```

## Express

```ts
import express from 'express';
import { paddleWebhook, paddleHealth } from 'paddle-kit/express';
import { billing } from './billing';

const app = express();
// Mount express.raw on the webhook route. Do NOT run express.json() before it.
app.post('/paddle', express.raw({ type: '*/*' }), paddleWebhook(billing));
app.get('/paddle', paddleHealth(billing)); // 404 unless healthToken is set
app.use(express.json()); // fine, but only AFTER the webhook route
```

If the body was already parsed, the adapter returns **500 `missing_raw_body`** by design (a re-serialised body can never match the signature) and records the failure. If a handler throws, both Express handlers log `store_error` and answer **500 `{ "error": "store_error" }`** (Express 4 does not catch async rejections).

## Paddle events to subscribe

Create a notification destination (type: webhook) pointing at your route and subscribe it to:

`subscription.created`, `subscription.updated`, `subscription.activated`, `subscription.trialing`, `subscription.past_due`, `subscription.paused`, `subscription.resumed`, `subscription.canceled`, `customer.created`, `customer.updated`, `transaction.completed`.

`subscription.imported` is treated like `subscription.created`. `transaction.completed` and `transaction.paid` (and, since v0.3, `adjustment.created` / `adjustment.updated`) are recorded as `processed` with no state change unless you pass `onTransaction` (fires on `transaction.completed` only; `transaction.paid` is record-only) / `onAdjustment` to `createBilling`; in v0.2 `transaction.paid` and `adjustment.*` were stored as `ignored`. A hook that throws fails the event (HTTP 500, reason `hook_error`, visible in health) so Paddle retries. Any other event type is stored as `ignored` and acknowledged with 200.

## Monitoring

Set `healthToken` to expose the health route (`GET` on the same path, `Authorization: Bearer <token>`). Without `healthToken` the route returns 404; with a wrong token, 401. If the store is down the route returns **503 `{ "error": "store_error" }`** (and logs `store_error`) instead of throwing. There is no pinger: the signal comes from real webhook traffic.

A stale `lastEventAt` is the primary "alive" signal: if no verified event has arrived for longer than your normal traffic gap, investigate. `failedLast24h` includes unsigned bot requests on a public endpoint, so a non-zero count alone is not an outage.

| Field | Meaning |
|---|---|
| `lastEventAt` | When the last verified event (processed, ignored or stale) was received. `null` if none yet. |
| `lastFailureAt` | Time of the most recent failure (a rejected request or a failed event). |
| `lastFailureReason` | Our own reason code for it, never secret or driver text. |
| `failedLast24h` | Rejected requests plus failed events in the last 24 h. |
| `unlinkedLast24h` | Subscription events with no `userId` (stored with `user_id = NULL`, event reason `no_user_id`). Fix by creating checkouts through `createCheckout`, which sets `customData.userId`. |

Reason codes: `missing_body`, `missing_raw_body`, `bad_signature_header`, `signature_mismatch`, `stale_timestamp`, `bad_json`, `bad_payload`, `unknown_event`, `no_user_id`, `out_of_order`, `store_error`, `hook_error`. Logs carry only `reason`, `eventId` and `eventType`, never the body, signature header or secrets.

**`failedLast24h` is an approximation.** Rejected requests are counted per minute and reason; a whole minute bucket counts if its latest hit is inside the 24 h window, so it can over-count by up to one minute of hits at the window edge.

**Retries.** Paddle retries every non-2xx response. Live: 60 attempts over about 3 days. Sandbox: 3 attempts over about 15 minutes. After that the event is dropped, so a broken endpoint must be noticed within the window. After any outage, run `reconcile` from an existing cron:

```ts
import { reconcile } from 'paddle-kit/reconcile';
await reconcile(billing, { apiKey: process.env.PADDLE_API_KEY! }); // { scanned, applied }
```

The webhook path itself only writes to your store; it never calls the Paddle API (Paddle's 5-second delivery deadline). Signature tolerance defaults to 5 seconds.

## Known issues (v0.1.1)

- **past_due grace can drift.** The grace start is computed from the stored row, so concurrent `past_due` deliveries can extend grace by the gap between them. A lost or late recovery event can also merge two `past_due` episodes into one and end grace early (the customer is denied). `reconcile` does **not** correct a drifted grace start (it carries the stored value forward); fix it by hand with `UPDATE paddle_subscriptions SET past_due_since = '<first past_due time>' WHERE subscription_id = '<sub_id>'`, or wait for the subscription to leave `past_due`.
- **Health does not split failure counts per reason.** `failedLast24h` is a single total; only the latest reason is reported.

## Verification status

- **Sandbox end to end (2026-10-16):** real Paddle-signed simulator deliveries through a tunnel into paddle-kit on Postgres (PGlite). A subscription for a known user turned `hasAccess` on, `past_due` kept access and started the grace clock, `canceled` turned it off, a failed-renewal burst ended `canceled`, a wrong webhook secret gave 401 with `signature_mismatch` in health, and `reconcile` ran against the real sandbox API. Test fixtures are those captured payloads (see `tests/fixtures/SOURCES.md`).
- Still **UNVERIFIED**: a real checkout (Paddle.js with a test card) and a real renewal. In particular, whether `current_billing_period` advances when a renewal fails; the simulator's demo subscription keeps a fixed period.
- The edge-runtime test and `npm run check:edge` cover API use, not every edge host's quirks; a deploy to a real edge target is **UNVERIFIED**.
- The Neon HTTP driver usage above is **UNVERIFIED** by us.

## Kosovo payout note

Kosovo seller payout eligibility is **UNVERIFIED**. Paddle's sanctions page does not list Kosovo as excluded and payouts can be in EUR, but no official statement confirms payouts to a Kosovo seller. Confirm with Paddle (support or a completed seller verification) before using live keys. Building and testing in sandbox is unaffected.

## Scripts

`npm test`, `npm run typecheck`, `npm run build`, `npm run check:edge` (static scan of the edge-safe bundles), `npm run smoke` (packs the tarball, installs it into a temp dir and imports every subpath).
