# paddle-kit

Drop-in billing layer for web projects that sell through **Paddle Billing** (v2, not Classic): verified webhooks, subscription state mirrored into your own Postgres, and one `hasAccess(userId, feature)` check.
Framework-agnostic core (Web-standard APIs only, no runtime dependencies), with adapters for Next.js, Hono and Express.

Not for in-app purchases in store-distributed mobile apps. Google Play and the App Store require their own billing for digital goods; Paddle covers web checkout only.

## Install

```bash
npm i github:SnaxxTech/paddle-kit#v0.3.0
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
| `PADDLE_PRICES` | server | JSON price map (`{ "team": { "monthly": "pri_..", "yearly": "pri_.." }, "pack": "pri_.." }`). Written by the catalog CLI, validated by `readBillingEnv`. |
| `BILLING_LAUNCH_AT`, `BILLING_ENFORCE` | server | Optional, read by `readBillingEnv`: ISO launch time with a timezone; enforcement is on only for exactly `1`. |

`readBillingEnv` (below) checks all of these at once and names the broken variable instead of throwing later.

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

## One-time purchases and refunds (hooks)

`createBilling` takes two optional hooks. They run after the event is recorded and before it is marked processed, **at least once** (a retry after a store failure, or concurrent duplicate deliveries, can run them again). Throwing fails the event (HTTP 500, reason `hook_error`) so Paddle retries; keep hooks fast, Paddle waits about 5 s.

- `onTransaction(tx, ctx)` fires on `transaction.completed` only (`transaction.paid` is recorded without a hook).
  **`transaction.completed` also fires for every subscription renewal**, so a one-time-purchase handler must filter `tx.subscriptionId === null`.
- `onAdjustment(adj, ctx)` fires on `adjustment.created` and `adjustment.updated`. A refund can arrive as `pending_approval`, then `approved` or `rejected`: act on a refund (`adj.action === 'refund'`) **only when `adj.status === 'approved'`**, and key your side effect on `adj.adjustmentId` + `adj.status`. Find your order by `adj.transactionId`.

`custom_data` comes from the browser and is untrusted. Verify the order by `tx.items` (`priceId`, `quantity`) and `tx.currency`; the catalog price fixes the amount. `tx.subtotal` is before discount and tax (net of tax for tax-inclusive prices) and `tx.total` is the tax-inclusive grand total, so **do not equality-check either amount against a list price** (discounts, tax and currency conversion all change them). Amounts are lowest-unit strings.

```ts
import { createBilling } from 'paddle-kit/core';

const PACK_PRICE = JSON.parse(process.env.PADDLE_PRICES!).pack as string; // a flat (one-time) price id

export const billing = createBilling({
  // ...environment, webhookSecret, store, entitlements as above
  onTransaction: async (tx) => {
    if (tx.subscriptionId !== null) return; // renewal or subscription start, not a one-time purchase
    const item = tx.items[0];
    if (tx.items.length !== 1 || item?.priceId !== PACK_PRICE || item.quantity !== 1 || tx.currency !== 'USD') {
      // Not the purchase we sell. Log and return: throwing would only make Paddle retry the same payload for days.
      console.warn('unexpected transaction shape', tx.transactionId);
      return;
    }
    const userId = tx.customData?.userId; // set by createCheckout; a user can only pay for someone else, not take from them
    if (typeof userId !== 'string') return;
    // Idempotent on transactionId: the unique key makes a replay a no-op (INSERT ... ON CONFLICT DO NOTHING).
    const first = await orders.insertOnce({ id: tx.transactionId, userId, credits: 5 });
    if (first) await credits.add(userId, 5);
  },
  onAdjustment: async (adj) => {
    if (adj.action !== 'refund' || adj.status !== 'approved') return; // pending_approval / rejected: do nothing yet
    const order = await orders.byId(adj.transactionId); // the order is keyed by the transaction
    if (!order) return;
    // Idempotent on adjustmentId (a full refund is one adjustment; a partial one is another).
    if (await refunds.insertOnce({ id: adj.adjustmentId, orderId: order.id })) await credits.add(order.userId, -order.credits);
  },
});
```

`insertOnce` is your own code: an insert that returns `false` when the id already exists.

## Plan state

`paddle-kit/plan` is a pure function (edge-safe, no dependencies) for "what may this account do": exempt, paid, in trial, or expired.

```ts
import { planOf } from 'paddle-kit/plan';

const plan = planOf({
  exempt: user.isDemo,
  startedAt: user.createdAt.getTime(),
  launchAt: env.launchAt, // from readBillingEnv; accounts older than launch get their trial from launch
  trialDays: 30,
  subscribed: await billing.hasAccess(user.id, 'pro'),
  now: Date.now(),
});
// { kind: 'free' } | { kind: 'paid' } | { kind: 'trial', endsAt, daysLeft } | { kind: 'expired', endedAt }
```

- `exempt` wins over everything, then `subscribed`. `launchAt: null` means "no launch grace" (the trial counts from `startedAt`), **not** "billing is off".
- **`trialDays: 0` with a `launchAt` in the future returns `expired` immediately.** Gate enforcement on the launch (`now >= launchAt`, or a `BILLING_ENFORCE` flag) before acting on `expired`.
- **Apps with a free tier** use `trialDays: 0` and treat `expired` as "free limits", not as a lockout. Only an app that has no free tier locks out on `expired`.

## Env validation (`readBillingEnv`) - build-safe pattern

`paddle-kit/config` validates the billing environment and **never puts a value in a problem string** (only variable names and the price keys you asked for).

```ts
import { readBillingEnv } from 'paddle-kit/config';

export const { config, problems } = readBillingEnv(process.env, {
  requiredPrices: ['team', 'pack'],
  requiredCycles: ['monthly', 'yearly'], // every NESTED required entry (team) needs both; flat entries (pack) are exempt
  requireLaunchAt: false,
});
```

- Nothing in the watched set is set (`PADDLE_ENV`, `PADDLE_NOTIFICATION_WEBHOOK_SECRET`, `PADDLE_PRICES`, `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`, `BILLING_LAUNCH_AT`, `BILLING_ENFORCE`): `{ config: null, problems: [] }`, silently. This is what a CI or preview build sees.
- Some set but invalid or incomplete: `config: null` plus `problems`. Whitespace-only values count as missing. An unknown `PADDLE_ENV` is reported once, without derived token-prefix mismatches.
- `PADDLE_ENV` defaults to `sandbox`; `test_` / `pdl_sdbx_` credentials must go with sandbox and `live_` / `pdl_live_` with production.

**Build-safe pattern: construct `createBilling` only when `config` is non-null.** `createBilling` throws on a missing secret, so building it at module scope breaks `next build` wherever billing is not configured.

```ts
import { createBilling } from 'paddle-kit/core';

if (problems.length > 0) console.error('billing misconfigured:', problems.join('; ')); // loud, but only when partly set

export const billing = config
  ? createBilling({ environment: config.environment, webhookSecret: config.webhookSecret, store, entitlements })
  : null; // billing off: callers check for null and serve the free experience
```

## Catalog CLI

`paddle-kit-catalog` creates and syncs a **sandbox** catalog from a JSON file: product, prices, the webhook destination and a client token, then writes the results to an env file. It is idempotent: a second run changes nothing.

```jsonc
// paddle.catalog.json
{ "app": "myapp",
  "product": { "name": "MyApp", "taxCategory": "saas" },
  "prices": [
    { "key": "team", "cycle": "monthly", "name": "Team (monthly)", "amount": "1000", "currency": "USD" },
    { "key": "team", "cycle": "yearly",  "name": "Team (yearly)",  "amount": "9600", "currency": "USD" },
    { "key": "pack", "cycle": "once",    "name": "5 credits",      "amount": "1499", "currency": "USD" } ] }
```

```bash
PADDLE_API_KEY=pdl_sdbx_... npx paddle-kit-catalog --catalog paddle.catalog.json --webhook-url https://my-tunnel.example.com/api/paddle
```

| Flag | Meaning |
|---|---|
| `--catalog <path>` | Catalog JSON (default `paddle.catalog.json`). |
| `--webhook-url <url>` | The **full endpoint URL** Paddle posts to, including the path (for example `https://host/api/paddle`), https only. Enables the destination and client-token steps. Without it, only product and prices are synced. |
| `--env-file <path>` | Env file to read `PADDLE_API_KEY` from (after the process environment) and write results to (default `.env.local`). Written with mode 0600, key by key as each stage completes, other lines untouched. |
| `--teardown` | Archive the prices and product this tool created, and deactivate its destination. |
| `--live` | Allow a live (`pdl_live_`) key. Without it anything but a sandbox key is refused. |

- **Written to the env file:** `PADDLE_ENV`, `PADDLE_PRICES` (a price map: `once`-only keys are flat ids, recurring keys are `{ monthly, yearly }`), and with `--webhook-url` also `PADDLE_NOTIFICATION_WEBHOOK_SECRET` (read from the destination, nothing to copy by hand) and `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`.
- **Markers:** the product carries `custom_data.paddle_kit = "<app>"`, each price `custom_data.paddle_kit_price = "<key>-<cycle>"`, and the destination is described `"<app> (paddle-kit)"`. Re-runs and `--teardown` find their own resources only through these markers and never touch anything else (a product that has prices the tool did not create is kept on teardown). A changed `amount` patches only that price.
- **Refuses live/test mixes before sending any request:** a live key without `--live`, `--live` with a sandbox key, or a `test_` client token in the env file with a live key.
- The key is never printed; output and errors are redacted.

## Migrating an app that already has a catalog

The CLI finds resources by its own markers, so a catalog made by an older hand-written script is invisible to it: running the CLI next to it would create a **second product and a second destination**. Two destinations on one URL both post, each signing with a different secret, so one of them always fails `signature_mismatch`.

Example (Offday): its script used markers `offday` / `offday_price` and the destination `Offday (sandbox)`. Before the first CLI run, do one of these:

1. Run the old script's teardown (archives its prices and product, deactivates its destination), or
2. Deactivate the old destination in the Paddle dashboard (Developer tools > Notifications) and archive the old catalog by hand.

Then run the CLI and replace the app's `PADDLE_PRICES` and `PADDLE_NOTIFICATION_WEBHOOK_SECRET` with the new values. Existing subscriptions on archived prices should keep renewing and only new checkouts need the new price ids (**UNVERIFIED** by us: confirm in sandbox before archiving a live catalog). Check afterwards that exactly one active destination points at your URL.

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

`subscription.created`, `subscription.updated`, `subscription.activated`, `subscription.trialing`, `subscription.past_due`, `subscription.paused`, `subscription.resumed`, `subscription.canceled`, `customer.created`, `customer.updated`, `transaction.completed`, and (for the hooks and the catalog CLI's destination) `transaction.paid`, `adjustment.created`, `adjustment.updated`.

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

**Recovered failures disappear.** A `hook_error` or `store_error` event counts in health only while it is `failed`. When Paddle's retry succeeds the event becomes `processed` and drops out of `lastFailureAt` / `failedLast24h`. A rejected request (bad signature, bad JSON) has no retry and stays for 24 h. So a clean health after an incident means "recovered", not "nothing happened": check your logs for `hook_error`, and treat a stale `lastEventAt` as the primary signal.

**Retries.** Paddle retries every non-2xx response. Live: 60 attempts over about 3 days. Sandbox: 3 attempts over about 15 minutes. After that the event is dropped, so a broken endpoint must be noticed within the window. After any outage, run `reconcile` from an existing cron:

```ts
import { reconcile } from 'paddle-kit/reconcile';
await reconcile(billing, { apiKey: process.env.PADDLE_API_KEY! }); // { scanned, applied }
```

The webhook path itself only writes to your store; it never calls the Paddle API (Paddle's 5-second delivery deadline). Signature tolerance defaults to 5 seconds.

## Integration checklist

Run this once per app, in sandbox first and then again for live.

1. **Default payment link (dashboard only).** In the Paddle dashboard (Checkout settings), set a *default payment link* to a public `https` URL of your app (the page that calls `createCheckout`). It cannot be set through the API. **Sandbox and live are separate accounts: set it in both**, or checkout fails to open there.
2. **Catalog.** Run `paddle-kit-catalog --webhook-url https://<host>/api/paddle` (see Catalog CLI) and read the printed table. Never copy the webhook secret by hand.
3. **Env validation.** Deploy with `readBillingEnv` and check that `problems` is empty in the deployed environment, not only locally.
4. **Private-dependency CI token.** paddle-kit is installed from a private GitHub repo, so CI needs a read token. Create a fine-grained token with read access to the `SnaxxTech/paddle-kit` contents, store it as the repository secret `PADDLE_KIT_READ_TOKEN`, and rewrite all three GitHub URL forms npm can emit before `npm ci`:
   ```bash
   for from in "ssh://git@github.com/" "git@github.com:" "https://github.com/"; do
     git config --global url."https://x-access-token:${PADDLE_KIT_READ_TOKEN}@github.com/".insteadOf "$from"
   done
   ```
   Pass the secret to that step with `env: PADDLE_KIT_READ_TOKEN: ${{ secrets.PADDLE_KIT_READ_TOKEN }}`. **Verify the secret exists** instead of assuming it: `gh api repos/<owner>/<repo>/actions/secrets --jq '.secrets[].name'` must list `PADDLE_KIT_READ_TOKEN`. A missing secret expands to an empty string and the install fails with an unhelpful auth error.
5. **Tunnel restarts change the URL.** A quick tunnel gets a new hostname on every start. Re-run the catalog CLI with the new `--webhook-url`: it re-points the existing destination and keeps its secret.
6. **Test checkout.** In sandbox pay with the test card `4242 4242 4242 4242`, any future expiry and any CVC. Confirm `subscription.*` and `transaction.completed` arrive and `hasAccess` flips.
7. **Wrong-secret drill.** Set `PADDLE_NOTIFICATION_WEBHOOK_SECRET` to a wrong value, redeploy, and send a simulator event: expect HTTP 401 and `lastFailureReason: "signature_mismatch"` in health. Restore the real secret, **redeploy again** (an env change is a deploy), and confirm the next real event is accepted.
8. **Go live.** Repeat steps 1-3, 6 and 7 with live credentials (`--live` for the CLI, `PADDLE_ENV=production`, a `live_` client token). Sandbox and live never mix.

## Known issues (v0.1.1)

- **past_due grace can drift.** The grace start is computed from the stored row, so concurrent `past_due` deliveries can extend grace by the gap between them. A lost or late recovery event can also merge two `past_due` episodes into one and end grace early (the customer is denied). `reconcile` does **not** correct a drifted grace start (it carries the stored value forward); fix it by hand with `UPDATE paddle_subscriptions SET past_due_since = '<first past_due time>' WHERE subscription_id = '<sub_id>'`, or wait for the subscription to leave `past_due`.
- **Health does not split failure counts per reason.** `failedLast24h` is a single total; only the latest reason is reported.

## Verification status

- **Sandbox end to end (2026-10-16):** real Paddle-signed simulator deliveries through a tunnel into paddle-kit on Postgres (PGlite). A subscription for a known user turned `hasAccess` on, `past_due` kept access and started the grace clock, `canceled` turned it off, a failed-renewal burst ended `canceled`, a wrong webhook secret gave 401 with `signature_mismatch` in health, and `reconcile` ran against the real sandbox API. Test fixtures are those captured payloads (see `tests/fixtures/SOURCES.md`).
- **Catalog CLI (2026-10-16):** run against the real Paddle sandbox with a throw-away app: product, monthly/yearly and one-time prices, destination and client token were created, a second run was a no-op, teardown archived only its own resources, and the env file was written with mode 0600.
- Still **UNVERIFIED** (v0.3): `onTransaction` / `onAdjustment` against a real one-time checkout and a real refund (covered by tests on captured payload shapes only), and the migration steps for an app with a pre-existing catalog.
- Still **UNVERIFIED**: a real checkout (Paddle.js with a test card) and a real renewal. In particular, whether `current_billing_period` advances when a renewal fails; the simulator's demo subscription keeps a fixed period.
- The edge-runtime test and `npm run check:edge` cover API use, not every edge host's quirks; a deploy to a real edge target is **UNVERIFIED**.
- The Neon HTTP driver usage above is **UNVERIFIED** by us.

## Kosovo payout note

Kosovo seller payout eligibility is **UNVERIFIED**. Paddle's sanctions page does not list Kosovo as excluded and payouts can be in EUR, but no official statement confirms payouts to a Kosovo seller. Confirm with Paddle (support or a completed seller verification) before using live keys. Building and testing in sandbox is unaffected.

## Scripts

`npm test`, `npm run typecheck`, `npm run build`, `npm run check:edge` (static scan of the edge-safe bundles), `npm run smoke` (packs the tarball, installs it into a temp dir and imports every subpath).
