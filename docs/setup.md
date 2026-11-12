# Setup

Reference moved out of the [README](../README.md). Start with the README's Quickstart; this file has the details.

Billing for SnaxxTech web apps that sell with **Paddle Billing** (v2, not Paddle Classic).

> **Team status:** what is done, what is next and who does it → [STATUS.md](../STATUS.md).
> **Upgrade an app:** [UPGRADING.md](../UPGRADING.md). **Changes per version:** [CHANGELOG.md](../CHANGELOG.md).

## In simple words (ELI5)

Think of a shop with one cash desk (Paddle) and many shelves (our apps: Offday, AppCare, QR-Lab).

- A customer pays at the cash desk. Paddle then sends a **message** (a webhook event) to every shelf: "this person paid", "this person stopped paying", "this payment was refunded".
- paddle-kit is the **helper at each shelf**. It reads each message and makes sure that the message is real (signed by Paddle). It writes the message in a **notebook** (your database) one time only, also if Paddle sends it two times.
- When a person opens a paid feature, the app asks the helper one question: **"Did this person pay?"** (`hasAccess`). The helper looks in the notebook and says yes or no.
- All our apps use **one cash desk** (one Paddle seller account). So every shelf hears about every sale. The helper keeps only the messages for its own shelf and ignores the rest (`owns`, new in v0.4.0).

What the kit does for you:

| You need | The kit gives you |
|---|---|
| Know if a user paid | `billing.hasAccess(userId, feature)` |
| Receive Paddle events safely | One webhook route: signature check, 5 s clock check, each event processed one time |
| Keep a copy of subscriptions | Tables in your own Postgres or SQLite (`paddle_*`) |
| Sell one-time items and handle refunds | Two hooks: `onTransaction`, `onAdjustment` |
| Trials and "free until launch" | `planOf()` in `paddle-kit/plan` |
| Check the env variables | `readBillingEnv()` names the bad variable, never its value |
| Create products and prices in Paddle | `npx paddle-kit-catalog` reads a JSON file, and prints the variables for your host |
| Open the checkout in the browser | `createCheckout()` in `paddle-kit/client` |
| Show the price that is set in Paddle | `getPrice()` and `formatPrice()` in `paddle-kit/price` (since v0.6.0) |
| Find a price by its catalog label, with no price id in the env | `findPrice()`, and `readBillingEnv({ resolvePrices })` (since v0.7.0) |
| A webhook route that is safe without env | `createWebhookRoute()` in `paddle-kit/next` (since v0.6.0) |
| Check a deployed app | `npx paddle-kit-doctor --url …` (since v0.6.0) |
| Check every app in one run (for a scheduled job) | `npx paddle-kit-doctor --apps apps.json [--json]` (since v0.7.0) |
| Your own checks in the health report | `createBilling({ healthChecks })` (since v0.7.0) |
| Repair after an outage | `reconcile()` copies subscriptions from the Paddle API |

What it does **not** do: in-app purchases in mobile store apps. Google Play and the App Store require their own billing for digital goods. Paddle is for web checkout only.

## Add the kit to a new Next.js app (since v0.6.0)

1. Install: `npm i github:SnaxxTech/paddle-kit#v0.9.3`.
2. Run one CLI command in the app folder: `npx paddle-kit-catalog --webhook-url https://<host>/api/paddle` (see [Catalog CLI](operations.md#catalog-cli)). It makes the product, the prices, the webhook destination and the client token, and writes `.env.local`.
3. Paste the host block that the CLI prints into your host's settings (Vercel: add `--host vercel` to get the commands). Redeploy.
4. Add the four files of the Quickstart (`lib/billing.ts`, the webhook route, the recovery route with `vercel.json`, `lib/policy.ts`), and call `canUse` where a paid feature starts.
5. Set the default payment link in the Paddle dashboard (Integration checklist, step 1).
6. Check the deployed app: `npx paddle-kit-doctor --url https://<host>/api/paddle --token <PADDLE_HEALTH_TOKEN>`.

The full list, with the sandbox test and the go-live steps, is the Integration checklist at the end of this file.

## Version notes

What each version changed, in simple words: [docs/HISTORY.md](HISTORY.md). Every detail: [CHANGELOG.md](../CHANGELOG.md). Upgrade steps: [UPGRADING.md](../UPGRADING.md).

## Words used in this file

| Word | Meaning |
|---|---|
| Event | One message from Paddle to your webhook route (for example `subscription.created`). |
| Ledger | The `paddle_events` table. It has one row per event. It makes sure that an event has an effect one time only. |
| Mirror | The `paddle_subscriptions` table: your copy of each subscription. |
| Store | The database adapter: `postgresStore`, `sqliteStore` or `memoryStore` (tests only). |
| Hook | Your function that the kit calls for a payment (`onTransaction`) or a refund (`onAdjustment`). |
| Sandbox | Paddle's test account. Test cards only, no real money. Sandbox and live never mix. |

## Install

```bash
npm i github:SnaxxTech/paddle-kit#v0.9.3
```

**The kit is not on the npm registry.** So `npx paddle-kit-catalog` in a folder that has not installed the kit fails with `npm error 404 Not Found`: npx looks for a package of that name on the registry. Two ways work:

- Run it in the app, after `npm i github:SnaxxTech/paddle-kit#v0.9.3`. Then `npx paddle-kit-catalog …` (and `npx paddle-kit-doctor …`) use the installed copy.
- Outside an app: `npx --package=github:SnaxxTech/paddle-kit#v0.9.3 paddle-kit-catalog …` (the same for `paddle-kit-doctor`). The catalog CLI then prints one line to say that it runs from the npx cache, because it writes its env file in the current folder.

- The repository is public (since v0.5.0). CI and the host install it with no token. Your secrets never go in this repository: each app keeps its own Paddle keys and webhook secret in its own env files and host settings (see Environment variables).
- The kit pins the Paddle API to version 1: each REST call sends `Paddle-Version: 1`, and the catalog CLI sets `api_version: 1` on the webhook destination. A new Paddle API version can then not change the payloads that the kit reads. Paddle refuses a version older than the account's default. So if a future Paddle account has a default newer than 1, each REST call and the destination step fail with `PaddleError`. This is on purpose: the kit's parsers must be updated first.
- `memoryStore` (`paddle-kit/memory`) is for tests and local development only. It keeps data in memory, and it is not shared between server instances. Use `postgresStore` or `sqliteStore` in production.
- The only optional peer dependency is `@paddle/paddle-js`. You need it only for `paddle-kit/client` (the browser checkout).
- `reconcile` and the catalog CLI call the Paddle REST API with `fetch`. You do not need the Paddle Node SDK (since v0.4.0).

## Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `PADDLE_ENV` | server | `sandbox` or `production`. |
| `PADDLE_NOTIFICATION_WEBHOOK_SECRET` | server | The secret key of the notification destination. Required: `createBilling` throws if it is missing or empty. `billing.config` never contains it. During a rotation, several secrets separated by commas (no spaces): see [Monitoring](operations.md#monitoring), "Rotate the webhook secret". |
| `PADDLE_API_KEY` | `reconcile`, `getPrice`, `findPrice`, `resolvePrices`, catalog CLI | `pdl_sdbx_...` for sandbox, `pdl_live_...` for production. A key that does not agree with `PADDLE_ENV` throws. Keys without these prefixes are refused. Required when `resolvePrices` is on and `PADDLE_PRICES` is unset. |
| `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` | browser | `test_...` for sandbox, `live_...` for production. A token that does not agree with the environment throws in `createCheckout`. |
| `PADDLE_PRICES` | server | A JSON price map, for example `{ "team": { "monthly": "pri_..", "yearly": "pri_.." }, "pack": "pri_.." }`. The catalog CLI writes it. `readBillingEnv` checks it. Optional when the app finds its prices by label (`resolvePrices`, since v0.7.0); then a set value is an override. |
| `BILLING_LAUNCH_AT` | server | Optional. The launch time, in ISO format with a timezone. |
| `BILLING_ENFORCE` | server | Optional. `1` turns enforcement on and `0` turns it off. When it is unset, enforcement is on if `PADDLE_ENV=production` (since v0.9.2). |
| `PADDLE_HEALTH_TOKEN` | server | Optional. Turns on the health route (see [Monitoring](operations.md#monitoring)). |

`readBillingEnv` (below) checks all of these at the same time. It names the bad variable, so that you do not get an error later.

**Set them on the host too, not only in `.env.local`.** `.env.local` is on your computer only. A deployed app reads only the variables in the host's settings (Vercel: Project > Settings > Environment Variables). A production app once had its checkout turned off for this reason: `PADDLE_PRICES` and `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` were only in `.env.local`. After each run, the catalog CLI prints the block to paste (see [Catalog CLI](operations.md#catalog-cli)), and `paddle-kit-doctor` shows what the deployed app sees. `NEXT_PUBLIC_` variables are read when the app is built, so redeploy after each change.

**Production guard:** `environment: 'production'` throws when `NODE_ENV` is set to a value that is not `'production'`. To skip this guard, pass `allowProductionInDev: true`. Runtimes without `NODE_ENV` (for example Cloudflare Workers) skip the guard.

## Run the migrations

The kit never changes your database schema itself. Do one of these two steps in each app:

- Import `MIGRATIONS` from `paddle-kit/postgres` (a list of `{ name, sql }`, in order). Run each `sql`. For SQLite, use `SQLITE_MIGRATIONS` from `paddle-kit/sqlite`.
- Or copy each `sql` into your own migration tool, one tool migration for each kit migration (AppCare does this with drizzle). Add a test that the copies stay equal to `MIGRATIONS`.

| Migration | Tables | Since |
|---|---|---|
| `001_init` | `paddle_events`, `paddle_subscriptions`, `paddle_customers` (unused since v0.5.0; see UPGRADING), `paddle_failures` | v0.1.0 |
| `002_claims_transactions` | `paddle_event_claims` (one row per event while a delivery runs its hooks), `paddle_transactions` (each transaction seen, and if it was this app's) | v0.4.0 |
| `003_recovery` | `paddle_recovery` (the recovery job's lease and checkpoint) | v0.8.0 |
| `004_claim_tokens_owned_ids` | `paddle_event_leases`, `paddle_owned_ids` | v0.8.0 |
| `005_fulfilment_outbox` | `paddle_fulfilments`, `paddle_fulfilment_adjustments`, `paddle_fulfilment_reviews`, `paddle_outbox` (used only by `paddle-kit/fulfil`; Postgres; SQLite has no 005) | v0.8.6 |
| `006_recovery_progress` | `paddle_recovery_progress` (where an interrupted recovery run stopped: its window, phase and next page) | v0.8.7 |

Rules:

1. **Run a new migration before you deploy the code that needs it.** v0.4.0 code on a database without `002` answers HTTP 500 `store_error` to each event. Paddle sends the events again, so nothing is lost, but the health route shows the failures.
2. The migrations use `CREATE TABLE IF NOT EXISTS`. If your database already has a table with one of these names but a different shape, the migration does nothing. Check for tables with these names before you migrate.
3. We never edit a migration after we ship it. A change comes as a new numbered migration.
4. `MIGRATIONS` is the only copy. The `migrations/*.sql` files were removed in v0.4.0.
5. **v0.8.0 adds `003_recovery` and `004_claim_tokens_owned_ids`** (new tables `paddle_recovery`, `paddle_event_leases`, `paddle_owned_ids`; nothing is altered or dropped). Run both before deploying v0.8.0: without `004` every event answers 500 `store_error` (Paddle retries, nothing is lost). `paddle_event_claims` is no longer used; drop it by hand later if you like.
6. **One set of tables per app and per environment** (a database, Neon branch or schema each). The tables have no app or environment column, so a shared set mixes events, subscriptions and the recovery checkpoint.

Timestamps are kept to the millisecond (Paddle sends microseconds). When two events for one subscription have the same millisecond, the later delivery wins.

## Lower-level setup: `createBilling` by hand

Prefer the Quickstart. Building `createBilling` yourself skips two of its defaults: pass
`paddleFetch: createPaddleTransport().fetch` for resilient Paddle calls, and set `owns` yourself (here from
`PADDLE_PRICES`; finding prices by label needs the historical ownership `billingFromEnv` wires up).

`lib/billing.ts`

```ts
import { Pool } from '@neondatabase/serverless';
import { priceIds, readBillingEnv } from 'paddle-kit/config';
import { createBilling, createPaddleTransport } from 'paddle-kit/core';
import { postgresStore } from 'paddle-kit/postgres';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const { config, problems } = readBillingEnv(process.env, { requiredPrices: ['pro'] });
if (problems.length > 0) console.error('billing misconfigured:', problems.join('; ')); // names only, never values

// Built only from a valid config: a CI or preview build without the secrets still builds. null = billing off.
export const billing = config
  ? createBilling({
      environment: config.environment,
      webhookSecret: config.webhookSecret,
      store: postgresStore({ query: (text, params) => pool.query(text, params) }),
      entitlements: Object.fromEntries(priceIds(config.prices.pro).map((id) => [id, ['pro']])), // price id -> features
      owns: config.owns, // the seller account is shared by several apps (see Shared seller accounts)
      pastDueGraceDays: 7,
      healthToken: config.healthToken, // optional, see Monitoring
      paddleFetch: createPaddleTransport().fetch, // retries, Retry-After and a circuit breaker for calls to Paddle
      // The kit logs only a reason code. This gets the error behind a failed hook, store call or price lookup.
      // It may hold secrets (a driver message with a connection string): send it to your error tracker, not to a public log.
      onError: (error, ctx) => console.error('paddle-kit failure', ctx, error),
    })
  : null;
```

`billing` is null while billing is off or misconfigured, so this is safe at module scope in a build without secrets.

`app/api/paddle/route.ts`

```ts
import { createWebhookRoute } from 'paddle-kit/next';
import { billing, problems } from '@/lib/billing';

export const { POST, GET } = createWebhookRoute({ billing, problems, healthToken: process.env.PADDLE_HEALTH_TOKEN });
```

What `createWebhookRoute` answers:

| State | POST (Paddle) | GET (health) |
|---|---|---|
| Billing on | `billing.handleWebhook` | `billing.handleHealth`; 404 `{ "error": "health_off" }` without `healthToken` |
| Billing off: no billing variable set, `problems` empty | 404 | 404 `{ "error": "billing_off" }` |
| Misconfigured: `problems` not empty | 503 | 503; with `Authorization: Bearer <healthToken>` also `{ "error": "misconfigured", "problems": [...] }` (names only) |

It never builds `billing` itself, so a missing secret cannot throw when the route file is imported. The `healthToken` option is used only while billing is off or misconfigured (then `config` is null, so `billing` has no token): `paddle-kit-doctor` uses it to show the problem names. `createNextRoute(billing)` (a `billing` that is never null) still works. Other frameworks: see Other frameworks.

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
        checkout.open({ items: [{ priceId: 'pri_01abc', quantity: 1 }], userId, email });
      }}
    >
      Upgrade
    </button>
  );
}
```

`billing` can be `null` (billing off). Callers check it: `billing ? await billing.hasAccess(userId, 'pro') : false`, or your app's free experience.

Always open the checkout with `createCheckout(...).open(...)`. It sets `customData.userId`, and the kit uses this value to link a subscription to your user. `open` throws if `userId` is empty.

`app/dashboard/page.tsx` (server component)

```tsx
import { billing } from '@/lib/billing';

export default async function Dashboard() {
  const userId = await getCurrentUserId(); // your auth
  const pro = billing ? await billing.hasAccess(userId, 'pro') : false;
  return pro ? <ProDashboard /> : <UpgradePrompt />;
}
```

`hasAccess` is true when the user has a subscription that gives the feature, and its status is one of these:

- `active` or `trialing`;
- `past_due`, for not more than `pastDueGraceDays`.

A cancellation at the end of the period stays `active` until Paddle changes it. `canceled` and `paused` give no access.

### Postgres clients

`postgresStore` takes `{ query }`, with the type `(text, params?) => Promise<{ rows }>`.

**`paddle-kit/db` (since v0.9.0)** gives one `{ query, transaction }` per client, for `postgresStore({ query: db.query })`
and `createFulfilment(db, …)`. Each is run on the real client in `tests/db-adapters.test.ts`:

```ts
import { fromPg, fromPostgresJs, fromPglite } from 'paddle-kit/db';
const db = fromPostgresJs(postgres(process.env.DATABASE_URL!));       // postgres-js (the starters' default)
// const db = fromPg(new Pool({ connectionString: process.env.DATABASE_URL })); // pg, or @neondatabase/serverless Pool
// const db = fromPglite(new PGlite());                                  // local development and tests
// const db = fromPostgresJsPerCall(() => postgres(url, { max: 1 }));    // Cloudflare Workers (v0.9.2), with Hyperdrive
```

**Cloudflare Workers:** a socket cannot be used by a request other than the one that opened it, so a client kept at
module scope works once and then fails ("Cannot perform I/O on behalf of a different request"). `fromPostgresJsPerCall`
opens a client per query and per transaction; behind Hyperdrive each connect is cheap. The starters' `lib/db.ts` picks
it on Workers by itself, and `tests/workerd-db.test.ts` runs each starter's `lib/db.ts` in real workerd on real Postgres.

- A transaction holds one connection from BEGIN to COMMIT. Neon's HTTP `neon()` has no interactive transactions: use its Pool.
- **postgres-js before v0.9.0, without drizzle:** postgres-js JSON-encodes a parameter Postgres types as jsonb, so the kit's JSON text was stored as a jsonb *string* (`price_ids` read back as `'["pri_…"]'`). A client wrapped by `drizzle(client)` was not affected: drizzle sets postgres-js's json/jsonb serializers to pass-through (QR-Lab and Slop Remover checked: every row stored correctly). The kit now sends jsonb as `$n::text::jsonb` on any client, and reads such old rows as their value.
- `pg` `Pool#query`, `@neondatabase/serverless` `Pool#query` and PGlite `db.query` fit directly. Put them in an arrow function (as above), so that `this` stays bound.
- Neon's HTTP driver: use `neon(url, { fullResults: true }).query`. A call to `neon(...)` itself as `sql(text, params)` throws in `@neondatabase/serverless` v1 and later. **UNVERIFIED** (not run against a real Neon HTTP endpoint).

### SQLite (better-sqlite3)

`sqliteStore` takes `{ db }`. This is any object with `prepare(sql)` (which returns `run`, `get` and `all`) and `exec(sql)`. `better-sqlite3` fits directly. It is for Node only, not for edge runtimes. Run the migrations one time at startup. They use `CREATE ... IF NOT EXISTS`, so a second run does no harm. Timestamps are kept as epoch milliseconds (INTEGER).

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

### Checkout: more than one line item, and Paddle.js events

```ts
import { createCheckout } from 'paddle-kit/client';

const checkout = await createCheckout({
  token: 'test_...',
  environment: 'sandbox',
  onEvent: (e) => console.log(e), // optional: every Paddle.js event (e.g. checkout.completed)
});
// One or more line items. items is required (the priceId/quantity shorthand was removed in v0.4.0):
checkout.open({ items: [{ priceId: 'pri_base', quantity: 1 }, { priceId: 'pri_extra', quantity: 12 }], userId: 'org_1' });
// Extra custom data (e.g. an order id) comes back on the transaction. userId is set from `userId`; extra customData cannot replace it in this call (the browser can still change custom data later):
checkout.open({ items: [{ priceId: 'pri_01abc', quantity: 1 }], userId: 'org_1', customData: { order_id: 'ord_7' } });
// After payment, Paddle.js sends checkout.completed (onEvent above). Go to your next page there; successUrl was removed in v0.4.0.
```

## Env validation (`readBillingEnv`): the build-safe pattern

`paddle-kit/config` checks the billing environment. **A problem message never contains a value.** It contains only variable names and the price keys that you asked for.

```ts
import { readBillingEnv } from 'paddle-kit/config';

export const { config, problems } = readBillingEnv(process.env, {
  requiredPrices: ['team', 'pack'],
  requiredCycles: ['monthly', 'yearly'], // every NESTED required entry (team) needs both; flat entries (pack) are exempt
  requireLaunchAt: false,
});
```

The three results:

| Situation | Result |
|---|---|
| No billing variable is set (`PADDLE_ENV`, `PADDLE_NOTIFICATION_WEBHOOK_SECRET`, `PADDLE_PRICES`, `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`, `BILLING_LAUNCH_AT`, `BILLING_ENFORCE`) | `{ config: null, problems: [] }`, with no message. A CI or preview build sees this. |
| Some are set, but one is bad or missing | `config: null`, and `problems` names each bad variable. A value of only spaces counts as missing. |
| All are good | `config` has the values. `config.owns` holds every price id from `PADDLE_PRICES`. `config.webhookSecrets` lists each secret (several during a rotation; `config.webhookSecret` is the first). |

- `PADDLE_ENV` is `sandbox` when it is not set.
- `test_` and `pdl_sdbx_` credentials go with sandbox. `live_` and `pdl_live_` credentials go with production.
- An unknown `PADDLE_ENV` is reported one time only.
- With `resolvePrices: { app }` (since v0.7.0) `PADDLE_PRICES` may be unset and `PADDLE_API_KEY` is required. The result then also has `config.resolvePrices()`. See [Find prices by their label](payments.md#find-prices-by-their-label-no-price-id-in-the-env-since-v070). Without the option nothing changes, also not the types.

**Build `createBilling` only when `config` is not null.** `createBilling` throws on a missing secret. If you build it at module scope, `next build` breaks in each place where billing is not set up.

```ts
import { createBilling } from 'paddle-kit/core';

if (problems.length > 0) console.error('billing misconfigured:', problems.join('; ')); // loud, but only when partly set

export const billing = config
  ? createBilling({ environment: config.environment, webhookSecret: config.webhookSecret, store, entitlements, owns: config.owns })
  : null; // billing off: callers check for null and serve the free experience
```

## Other frameworks

`billing.handleWebhook(req)` and `billing.handleHealth(req)` take a Web `Request` and return a `Response`. So Hono, Bun, Deno, Workers and Remix need no adapter. The Hono and Express adapters were removed in v0.4.0.

```ts
app.post('/paddle', (c) => billing.handleWebhook(c.req.raw)); // Hono: the untouched raw request
app.get('/paddle', (c) => billing.handleHealth(c.req.raw));
```

Express gives you a parsed body, and a parsed body never matches the signature. On this route, read the **raw** body and make a `Request` from it:

```ts
app.post('/paddle', express.raw({ type: '*/*' }), async (req, res) => {
  const r = await billing.handleWebhook(new Request('https://local/paddle', { method: 'POST', headers: req.headers as HeadersInit, body: req.body }));
  res.status(r.status).type('application/json').send(await r.text());
}); // mount express.json() only AFTER this route
```

- Both examples are **UNVERIFIED** (we did not run them after we removed the adapters).
- Express 4 does not catch async errors. Put the handler in `try { … } catch { res.status(500).json({ error: 'store_error' }) }`.

## Paddle events to subscribe

Make a notification destination (type: webhook) that points to your route. Subscribe it to these events:

`subscription.created`, `subscription.imported`, `subscription.updated`, `subscription.activated`, `subscription.trialing`, `subscription.past_due`, `subscription.paused`, `subscription.resumed`, `subscription.canceled`, `transaction.completed`, `transaction.paid`, `adjustment.created`, `adjustment.updated`.

The catalog CLI subscribes its destination to all 13. Do not subscribe `customer.*`: the kit ignores it (see below).

What the kit does with each event:

| Event | What the kit does |
|---|---|
| `subscription.*` | Updates the mirror. `subscription.imported` counts as `subscription.created`. |
| `customer.*` | Records it as `ignored`, reason `unknown_event`. Answers 200. Since v0.5.0 the kit stores no customer: on a shared seller account these events carry every app's customer emails, and the kit never read them. |
| `transaction.completed` | Records it as `processed`, and runs `onTransaction` if you set it. |
| `transaction.paid` | Records it as `processed`. No hook. |
| `adjustment.created`, `adjustment.updated` | Records them as `processed`, and runs `onAdjustment` if you set it. |
| Not ours (see `owns`) | Records it as `ignored`, reason `not_ours`. Answers 200. |
| Any other type | Records it as `ignored`. Answers 200. |

## Integration checklist

Do these steps one time for each app: first in sandbox, then again for live.

1. **Set the default payment link (dashboard only).**
   1. In the Paddle dashboard, open Paddle > Checkout > Checkout configuration.
   2. Set the *default payment link* to a public `https` URL of your app: the page that calls `createCheckout`. Paddle refuses `localhost`.
   3. **Do this in sandbox and in live.** They are different accounts. Without the link, checkout fails with `transaction_default_checkout_url_not_set`.
   4. Start Paddle.js when that page loads (for example, call `createCheckout` in an effect on mount, not only in a button click). Paddle opens a checkout link from the `_ptxn` query parameter when the page loads.

   We found no API for this setting (**UNVERIFIED** that there is none).
2. **Install the kit in the app:** `npm i github:SnaxxTech/paddle-kit#v0.9.3`. The kit is not on the npm registry, so run the CLIs in the app folder (or see Install for `npx --package=…`).
3. **Make the catalog.** Run `npx paddle-kit-catalog --webhook-url https://<host>/api/paddle` (see [Catalog CLI](operations.md#catalog-cli)). Read the table that it shows. Never copy the webhook secret by hand.
4. **Put the variables on the host.** Paste the host block that the CLI prints (`--host vercel` prints the commands). Add `PADDLE_HEALTH_TOKEN` (any long random value), and `PADDLE_API_KEY` if the app uses `getPrice`, `findPrice`, `resolvePrices` or `reconcile`. Redeploy.
5. **Add the code:** the four Quickstart files: `lib/billing.ts` with `billingFromEnv`, the webhook route, the recovery route with its `vercel.json` cron and `CRON_SECRET`, and `lib/policy.ts` with `canUse`. Pass `onError` so a failure's cause reaches your error tracker. Optional: show the price with `findPrice` or `getPrice` (see [Show the price from Paddle](payments.md#show-the-price-from-paddle-paddle-kitprice-since-v060)), so that the price lives only in Paddle, and report its source with a `healthChecks` entry. A one-time-purchase app may drop `PADDLE_PRICES` with `resolvePrices` (see [Find prices by their label](payments.md#find-prices-by-their-label-no-price-id-in-the-env-since-v070)).
6. **Check the deployed app:** `npx paddle-kit-doctor --url https://<host>/api/paddle --token <PADDLE_HEALTH_TOKEN>`. It must say `Billing: on` with the right environment, and `Result: OK`. Do this in each environment that takes payments (preview and production), not only on your computer. Then add the app to the scheduled `--apps` file with a `staleHours` that fits its traffic.
7. **Install in CI and on the host.** The kit is public since v0.5.0, so `npm ci` needs no token. An app that used the old private-repo recipe can delete the `PADDLE_KIT_READ_TOKEN` secret and its `git config ... insteadOf` step. A lockfile with a `git+ssh://` URL for the kit also installs with no SSH key: npm downloads public GitHub dependencies as a tarball (tested with npm 10.8.2, SSH turned off, no GitHub login). Each host is **UNVERIFIED** until its first install.
8. **A tunnel restart changes the URL.** A quick tunnel gets a new hostname each time it starts. Run the catalog CLI again with the new `--webhook-url`. It should move the existing destination and keep its secret. **UNVERIFIED**: after a restart, check that `PADDLE_NOTIFICATION_WEBHOOK_SECRET` in the env file still matches the destination.
9. **Do a test checkout.** In sandbox, pay with the test card `4242 4242 4242 4242`, any future expiry date and any CVC. Make sure that `subscription.*` and `transaction.completed` arrive, and that `hasAccess` changes.
10. **Do the wrong-secret drill.**
    1. Set `PADDLE_NOTIFICATION_WEBHOOK_SECRET` to a wrong value. Deploy.
    2. Send a simulator event. You must see HTTP 401 in the Paddle dashboard's delivery log, and `signature_mismatch` under `unverified.byReason` in health if the same server instance answers (a WARNING line in `paddle-kit-doctor`). Since v0.7.0 a refusal before the signature check is not written to the store, so `lastFailureReason` stays as it was. The durable sign is that no new event is verified: `lastEventAt` goes old and `--stale-hours` turns red.
    3. Put back the real secret. **Deploy again** (an env change is a deploy).
    4. Make sure that the next real event is accepted.
11. **Go live.** Do steps 1, 3, 4, 6, 9 and 10 again with live credentials:
    - Run the CLI with `--live` and a **separate env file** (`--env-file .env.production.local`, never the dev `.env.local`). Then a live key and a `test_` token cannot be in one file.
    - Use `PADDLE_ENV=production` and a `live_` client token.
