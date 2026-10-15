# paddle-kit

Drop-in billing layer for web projects that sell through **Paddle Billing** (v2, not Classic): verified webhooks, subscription state mirrored into your own Postgres, and one `hasAccess(userId, feature)` check.
Framework-agnostic core (Web-standard APIs only, no runtime dependencies), with adapters for Next.js, Hono and Express.

Not for in-app purchases in store-distributed mobile apps. Google Play and the App Store require their own billing for digital goods; Paddle covers web checkout only.

## Install

```bash
npm i github:SnaxxTech/paddle-kit#v0.1.0
```

Optional peer dependencies, install only what you use: `@paddle/paddle-node-sdk` (reconcile), `@paddle/paddle-js` (client checkout), `hono`, `express`.

## Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `PADDLE_ENV` | server | `sandbox` or `production`. Sandbox and live never mix. |
| `PADDLE_NOTIFICATION_WEBHOOK_SECRET` | server | The notification destination's secret key. Required: `createBilling` throws if it is missing or empty. `billing.config` never contains it. |
| `PADDLE_API_KEY` | `reconcile` only | `pdl_sdbx_...` for sandbox, `pdl_live_...` for production. A mismatch with `PADDLE_ENV` throws. |
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
          environment: 'sandbox',
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
import { paddleWebhook } from 'paddle-kit/express';
import { billing } from './billing';

const app = express();
// Mount express.raw on the webhook route. Do NOT run express.json() before it.
app.post('/paddle', express.raw({ type: '*/*' }), paddleWebhook(billing));
app.use(express.json()); // fine, but only AFTER the webhook route
```

If the body was already parsed, the adapter returns **500 `missing_raw_body`** by design (a re-serialised body can never match the signature) and records the failure.

## Paddle events to subscribe

Create a notification destination (type: webhook) pointing at your route and subscribe it to:

`subscription.created`, `subscription.updated`, `subscription.activated`, `subscription.trialing`, `subscription.past_due`, `subscription.paused`, `subscription.resumed`, `subscription.canceled`, `customer.created`, `customer.updated`, `transaction.completed`.

`subscription.imported` is treated like `subscription.created`. `transaction.completed` is recorded with no state change in v0.1 (one-time purchases are deferred). Any other event type is stored as `ignored` and acknowledged with 200.

## Monitoring

Set `healthToken` to expose the health route (`GET` on the same path, `Authorization: Bearer <token>`). Without `healthToken` the route returns 404; with a wrong token, 401. There is no pinger: the signal comes from real webhook traffic.

| Field | Meaning |
|---|---|
| `lastEventAt` | When the last verified event (processed, ignored or stale) was received. `null` if none yet. |
| `lastFailureAt` | Time of the most recent failure (a rejected request or a failed event). |
| `lastFailureReason` | Our own reason code for it, never secret or driver text. |
| `failedLast24h` | Rejected requests plus failed events in the last 24 h. |
| `unlinkedLast24h` | Subscription events with no `userId` (stored with `user_id = NULL`, event reason `no_user_id`). Fix by creating checkouts through `createCheckout`, which sets `customData.userId`. |

Reason codes: `missing_body`, `missing_raw_body`, `bad_signature_header`, `signature_mismatch`, `stale_timestamp`, `bad_json`, `bad_payload`, `unknown_event`, `no_user_id`, `out_of_order`, `store_error`. Logs carry only `reason`, `eventId` and `eventType`, never the body, signature header or secrets.

**`failedLast24h` is an approximation.** Rejected requests are counted per minute and reason; a whole minute bucket counts if its latest hit is inside the 24 h window, so it can over-count by up to one minute of hits at the window edge.

**Retries.** Paddle retries every non-2xx response. Live: 60 attempts over about 3 days. Sandbox: 3 attempts over about 15 minutes. After that the event is dropped, so a broken endpoint must be noticed within the window. After any outage, run `reconcile` from an existing cron:

```ts
import { reconcile } from 'paddle-kit/reconcile';
await reconcile(billing, { apiKey: process.env.PADDLE_API_KEY! }); // { scanned, applied }
```

The webhook path itself only writes to your store; it never calls the Paddle API (Paddle's 5-second delivery deadline). Signature tolerance defaults to 5 seconds.

## Verification status

- Test fixtures are Paddle docs example payloads (Apr 2024), **not** captures from the sandbox webhook simulator. A real sandbox checkout through a tunnel is still an open verification gap.
- The edge-runtime test and `npm run check:edge` cover API use, not every edge host's quirks; a deploy to a real edge target is **UNVERIFIED**.
- The Neon HTTP driver usage above is **UNVERIFIED** by us.

## Kosovo payout note

Kosovo seller payout eligibility is **UNVERIFIED**. Paddle's sanctions page does not list Kosovo as excluded and payouts can be in EUR, but no official statement confirms payouts to a Kosovo seller. Confirm with Paddle (support or a completed seller verification) before using live keys. Building and testing in sandbox is unaffected.

## Scripts

`npm test`, `npm run typecheck`, `npm run build`, `npm run check:edge` (static scan of the edge-safe bundles), `npm run smoke` (packs the tarball, installs it into a temp dir and imports every subpath).
