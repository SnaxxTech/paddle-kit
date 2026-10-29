# paddle-kit

Billing for SnaxxTech web apps that sell with **Paddle Billing** (v2, not Paddle Classic).

> **Team status:** what is done, what is next and who does it → [STATUS.md](STATUS.md).
> **Upgrade an app:** [UPGRADING.md](UPGRADING.md). **Changes per version:** [CHANGELOG.md](CHANGELOG.md).

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

1. Install: `npm i github:SnaxxTech/paddle-kit#v0.7.0`.
2. Run one CLI command in the app folder: `npx paddle-kit-catalog --webhook-url https://<host>/api/paddle` (see Catalog CLI). It makes the product, the prices, the webhook destination and the client token, and writes `.env.local`.
3. Paste the host block that the CLI prints into your host's settings (Vercel: add `--host vercel` to get the commands). Redeploy.
4. Add `lib/billing.ts` and the route file `app/api/paddle/route.ts` (see Next.js example), and call `billing.hasAccess` where a paid feature starts.
5. Set the default payment link in the Paddle dashboard (Integration checklist, step 1).
6. Check the deployed app: `npx paddle-kit-doctor --url https://<host>/api/paddle --token <PADDLE_HEALTH_TOKEN>`.

The full list, with the sandbox test and the go-live steps, is the Integration checklist at the end of this file.

## What v0.7.0 changed (simple words)

1. **Bots cannot keep the database awake.** A request without a valid Paddle signature is answered and counted in memory only. Before, each one wrote a row, so a bot on the URL kept a serverless Postgres (Neon) running.
2. **Live apps get real events only.** The catalog CLI sets a live destination to `traffic_source: platform`. Simulated events reach sandbox apps only.
3. **Prices by name.** An app can find its prices in Paddle by the catalog label (`findPrice`, `resolvePrices`), so its env needs no price ids. If Paddle cannot answer, the webhook asks Paddle to retry (503); it never throws an event away.
4. **One command checks every app.** `paddle-kit-doctor --apps apps.json --json` gives one result per app, for a job that opens an issue when an app turns red.
5. **Your own checks in health** (`healthChecks`), the cause of a failure for your error tracker (`onError`), time limits for hooks and the store, and several webhook secrets at once for a rotation.

## What v0.4.0 changed (simple words)

1. **Apps share one seller account safely.** Each app tells the kit which prices are its own (`owns`). The kit ignores other apps' events. It records them as `not_ours`, and they are not errors.
2. **A refund is never lost.** A refund can arrive before its payment. The kit gives that refund to your app with `known: false`, so that your app can keep a record of it.
3. **No double processing.** Before v0.4.0, 50 copies of one event sent at the same time ran your hook up to 50 times. Now the hook runs one time. The other copies get HTTP 409 `in_progress`, and Paddle sends them again later. This was tested on a real Postgres 17 server.
4. **Less code.** We removed the parts that no app used: the Express and Hono adapters, the Paddle Node SDK and some exports. [UPGRADING.md](UPGRADING.md) gives the replacement for each.
5. **One new migration:** `002_claims_transactions`. Run it **before** you deploy v0.4.0.

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
npm i github:SnaxxTech/paddle-kit#v0.7.0
```

**The kit is not on the npm registry.** So `npx paddle-kit-catalog` in a folder that has not installed the kit fails with `npm error 404 Not Found`: npx looks for a package of that name on the registry. Two ways work:

- Run it in the app, after `npm i github:SnaxxTech/paddle-kit#v0.7.0`. Then `npx paddle-kit-catalog …` (and `npx paddle-kit-doctor …`) use the installed copy.
- Outside an app: `npx --package=github:SnaxxTech/paddle-kit#v0.7.0 paddle-kit-catalog …` (the same for `paddle-kit-doctor`). The catalog CLI then prints one line to say that it runs from the npx cache, because it writes its env file in the current folder.

- The repository is public (since v0.5.0). CI and the host install it with no token. Your secrets never go in this repository: each app keeps its own Paddle keys and webhook secret in its own env files and host settings (see Environment variables).
- The kit pins the Paddle API to version 1: each REST call sends `Paddle-Version: 1`, and the catalog CLI sets `api_version: 1` on the webhook destination. A new Paddle API version can then not change the payloads that the kit reads. Paddle refuses a version older than the account's default. So if a future Paddle account has a default newer than 1, each REST call and the destination step fail with `PaddleError`. This is on purpose: the kit's parsers must be updated first.
- `memoryStore` (`paddle-kit/memory`) is for tests and local development only. It keeps data in memory, and it is not shared between server instances. Use `postgresStore` or `sqliteStore` in production.
- The only optional peer dependency is `@paddle/paddle-js`. You need it only for `paddle-kit/client` (the browser checkout).
- `reconcile` and the catalog CLI call the Paddle REST API with `fetch`. You do not need the Paddle Node SDK (since v0.4.0).

## Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `PADDLE_ENV` | server | `sandbox` or `production`. |
| `PADDLE_NOTIFICATION_WEBHOOK_SECRET` | server | The secret key of the notification destination. Required: `createBilling` throws if it is missing or empty. `billing.config` never contains it. During a rotation, several secrets separated by commas (no spaces): see Monitoring, "Rotate the webhook secret". |
| `PADDLE_API_KEY` | `reconcile`, `getPrice`, `findPrice`, `resolvePrices`, catalog CLI | `pdl_sdbx_...` for sandbox, `pdl_live_...` for production. A key that does not agree with `PADDLE_ENV` throws. Keys without these prefixes are refused. Required when `resolvePrices` is on and `PADDLE_PRICES` is unset. |
| `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` | browser | `test_...` for sandbox, `live_...` for production. A token that does not agree with the environment throws in `createCheckout`. |
| `PADDLE_PRICES` | server | A JSON price map, for example `{ "team": { "monthly": "pri_..", "yearly": "pri_.." }, "pack": "pri_.." }`. The catalog CLI writes it. `readBillingEnv` checks it. Optional when the app finds its prices by label (`resolvePrices`, since v0.7.0); then a set value is an override. |
| `BILLING_LAUNCH_AT` | server | Optional. The launch time, in ISO format with a timezone. |
| `BILLING_ENFORCE` | server | Optional. Enforcement is on only when the value is exactly `1`. |
| `PADDLE_HEALTH_TOKEN` | server | Optional. Turns on the health route (see Monitoring). |

`readBillingEnv` (below) checks all of these at the same time. It names the bad variable, so that you do not get an error later.

**Set them on the host too, not only in `.env.local`.** `.env.local` is on your computer only. A deployed app reads only the variables in the host's settings (Vercel: Project > Settings > Environment Variables). A production app once had its checkout turned off for this reason: `PADDLE_PRICES` and `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` were only in `.env.local`. After each run, the catalog CLI prints the block to paste (see Catalog CLI), and `paddle-kit-doctor` shows what the deployed app sees. `NEXT_PUBLIC_` variables are read when the app is built, so redeploy after each change.

**Production guard:** `environment: 'production'` throws when `NODE_ENV` is set to a value that is not `'production'`. To skip this guard, pass `allowProductionInDev: true`. Runtimes without `NODE_ENV` (for example Cloudflare Workers) skip the guard.

## Run the migrations

The kit never changes your database schema itself. Do one of these two steps in each app:

- Import `MIGRATIONS` from `paddle-kit/postgres` (a list of `{ name, sql }`, in order). Run each `sql`. For SQLite, use `SQLITE_MIGRATIONS` from `paddle-kit/sqlite`.
- Or copy each `sql` into your own migration tool, one tool migration for each kit migration (AppCare does this with drizzle). Add a test that the copies stay equal to `MIGRATIONS`.

| Migration | Tables | Since |
|---|---|---|
| `001_init` | `paddle_events`, `paddle_subscriptions`, `paddle_customers` (unused since v0.5.0; see UPGRADING), `paddle_failures` | v0.1.0 |
| `002_claims_transactions` | `paddle_event_claims` (one row per event while a delivery runs its hooks), `paddle_transactions` (each transaction seen, and if it was this app's) | v0.4.0 |

Rules:

1. **Run a new migration before you deploy the code that needs it.** v0.4.0 code on a database without `002` answers HTTP 500 `store_error` to each event. Paddle sends the events again, so nothing is lost, but the health route shows the failures.
2. The migrations use `CREATE TABLE IF NOT EXISTS`. If your database already has a table with one of these names but a different shape, the migration does nothing. Check for tables with these names before you migrate.
3. We never edit a migration after we ship it. A change comes as a new numbered migration.
4. `MIGRATIONS` is the only copy. The `migrations/*.sql` files were removed in v0.4.0.

Timestamps are kept to the millisecond (Paddle sends microseconds). When two events for one subscription have the same millisecond, the later delivery wins.

## Next.js (App Router) example

`lib/billing.ts`

```ts
import { Pool } from '@neondatabase/serverless';
import { readBillingEnv } from 'paddle-kit/config';
import { createBilling } from 'paddle-kit/core';
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
      entitlements: { [config.prices.pro as string]: ['pro'] }, // price id -> features it unlocks (a cycle map: one entry per id)
      owns: config.owns, // the seller account is shared by several apps (see Shared seller accounts)
      pastDueGraceDays: 7,
      healthToken: config.healthToken, // optional, see Monitoring
      // The kit logs only a reason code. This gets the error behind a failed hook, store call or price lookup.
      // It may hold secrets (a driver message with a connection string): send it to your error tracker, not to a public log.
      onError: (error, ctx) => console.error('paddle-kit failure', ctx, error),
    })
  : null;
```

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
// Extra custom data (e.g. an order id) comes back on the transaction. userId is always yours and cannot be overridden:
checkout.open({ items: [{ priceId: 'pri_01abc', quantity: 1 }], userId: 'org_1', customData: { order_id: 'ord_7' } });
// After payment, Paddle.js sends checkout.completed (onEvent above). Go to your next page there; successUrl was removed in v0.4.0.
```

## Show the price from Paddle (`paddle-kit/price`, since v0.6.0)

Keep the price in Paddle only. When the amount changes, the app shows the new amount, with no code change and no deploy.

- **A changed amount keeps its price id.** Paddle's `PATCH /prices/{id}` accepts a new `unit_price`, and the catalog CLI changes an amount in place (the same id). So `PADDLE_PRICES` stays the same, and an app that reads the price follows the change.
- `getPrice(priceId, { apiKey, environment, fetch?, timeoutMs? })` reads `GET /prices/{id}` with `Paddle-Version: 1`. It returns `{ id, amount, currency, interval, name, status }`. `amount` is a string in the lowest unit (`"1500"` = $15.00). `interval` is `null` for a one-time price, else `{ interval: 'month', frequency: 1 }`.
- Errors are `PriceError` (a `PaddleError`) with `code`: `unauthorized` (401/403, or a key for the other environment), `not_found` (404, or an id that is not `pri_…`), `timeout` (default 5 s), `network`, `malformed` (a 2xx answer that is not a price), `http` (any other status, in `status`). The message never contains the key.
- `formatPrice(amount, currency, locale = 'en-US')` uses `Intl.NumberFormat`. Whole amounts have no cents: `"1500"` USD is `$15`, `"999"` is `$9.99`. Zero-decimal currencies are not divided by 100: `"1500"` JPY is `¥1,500`.
- The kit does **not** cache. Each call is one request to Paddle. Cache it in the app.
- It needs `PADDLE_API_KEY` on the server (on the host too). Never import it in a client component: the key must not reach the browser.

Next.js 16 with Cache Components (`cacheComponents: true` in `next.config.ts`):

```ts
// lib/price.ts
import { cacheLife } from 'next/cache';
import { formatPrice, getPrice } from 'paddle-kit/price';
import { config } from '@/lib/billing';

const BUILT_IN_PRICE = '$15'; // shown when Paddle cannot be read

async function paddlePrice(priceId: string, environment: 'sandbox' | 'production'): Promise<string> {
  'use cache';
  cacheLife('hours'); // a price change shows within about an hour
  const price = await getPrice(priceId, { apiKey: process.env.PADDLE_API_KEY!, environment });
  return formatPrice(price.amount, price.currency);
}

export async function proPrice(): Promise<string> {
  if (!config || !process.env.PADDLE_API_KEY) return BUILT_IN_PRICE; // billing off
  try {
    return await paddlePrice(config.prices.pro as string, config.environment);
  } catch {
    return BUILT_IN_PRICE; // PriceError: keep the page up
  }
}
```

The fallback is outside the cached function, so that a short Paddle outage is not stored as the price for hours. **UNVERIFIED:** we did not run this example in a Next.js 16 app.

Paddle shows the buyer a local price in checkout (for example EUR). `getPrice` returns the base price only. For localised prices on a pricing page, use Paddle.js `PricePreview`.

### Find prices by their label: no price id in the env (since v0.7.0)

The catalog CLI labels what it makes: the product has `custom_data.paddle_kit = "<app>"`, and each price has `custom_data.paddle_kit_price = "<key>-<cycle>"` (cycle `monthly`, `yearly` or `once`). The kit can find a price by that label, so the app's env needs only `PADDLE_API_KEY` (plus the secret and the client token), not `PADDLE_PRICES`.

**Why:** LeakScan showed its built-in price for hours, because the id in `PADDLE_PRICES` was not the price the owner had edited in Paddle. With a label, the app reads the price the catalog CLI made, whatever its id.

- `findPrice({ app, key, cycle }, { apiKey, environment, fetch?, timeoutMs? })` lists the active prices (`GET /prices?status=active&include=product`, `Paddle-Version: 1`, every page) and returns the one labelled `<key>-<cycle>` on the active product labelled `app`, in the same shape as `getPrice`. Another app's price with the same label is not seen. Errors are `PriceError`: `not_found` (no active price has the label), **`ambiguous`** (more than one does: archive all but one), and the codes of `getPrice`.
- `findPriceMap(app, opts)` returns every labelled price of the app as the `PADDLE_PRICES` map the catalog CLI writes.
- `readBillingEnv(process.env, { requiredPrices, resolvePrices: { app: 'leakscan' } })`: `PADDLE_PRICES` may then be unset, and `PADDLE_API_KEY` becomes required. `config.prices` is `{}`; read the ids with **`await config.resolvePrices()`**, which looks them up (and checks `requiredPrices` / `requiredCycles`) or throws `PriceError`. A found map is kept for `cacheSeconds` (default 600) in the server instance; a failure is not kept, so the next call asks again. A set `PADDLE_PRICES` still wins: it is the override, and `resolvePrices()` then returns it with no request.
- **Webhooks fail closed.** In this mode `config.owns` is a resolver that `createBilling` awaits for each event whose ownership it decides (subscription and transaction events, and adjustments of a mirrored subscription; a refund of a one-time purchase is decided from `paddle_transactions` and needs no lookup). If the ids cannot be found (Paddle down, a wrong key, a missing label, no id at all), the event answers **503 `prices_unavailable`**, is marked `failed` (health shows it), and Paddle retries. An event is never marked `not_ours` because a lookup failed. Pass it the usual way: `owns: config.owns`.

```ts
// lib/billing.ts (a one-time purchase app, e.g. LeakScan)
export const { config, problems } = readBillingEnv(process.env, { requiredPrices: ['scan'], resolvePrices: { app: 'leakscan' } });
export const billing = config
  ? createBilling({
      environment: config.environment, webhookSecret: config.webhookSecret, store, entitlements: {},
      owns: config.owns, // a resolver here: a failed lookup answers 503, never not_ours
      onTransaction: async (tx) => {
        const { scan } = await config.resolvePrices(); // kept 10 min per instance
        if (!tx.items.some((i) => i.priceId === scan)) return writeReviewRow(tx); // never drop a paid order
        // ...grant in one DB transaction
      },
    })
  : null;
```

**An app with its own `owns` function** (LeakScan also matches its own `order_id`, so a sale with a wrong price still reaches review) keeps that function and builds it from the found ids: a resolver may return a predicate as well as ids.

```ts
const scanIds = async () => {
  const { scan } = await config.resolvePrices(); // kept 10 min per instance
  return [scan as string];
};
owns: { resolve: async () => leakScanOwns(await scanIds()) }, // (x) => boolean, built from the ids found by label
```

The trade-offs, so you can choose:

| | `PADDLE_PRICES` in the env | Found by label |
|---|---|---|
| A price edited or replaced in Paddle | The env must be changed too, then redeployed | Found on the next lookup (up to `cacheSeconds` late) |
| Paddle API down at a cold start | Not affected | Checkout ids and webhook ownership wait for Paddle; webhooks answer 503 and Paddle retries (live: up to 60 times in about two days) |
| A price made in the dashboard by hand | Works once its id is in the env | Not found: it has no label. Run the catalog CLI, or add `paddle_kit_price` to its custom data with the API |
| Two active prices with one label | Not affected | `ambiguous`: archive one |
| `entitlements` keyed by price id (`hasAccess`) | Works | `createBilling` needs the ids when it is built: subscription apps keep `PADDLE_PRICES` for now |
| Extra Paddle API calls | None | One list per instance every `cacheSeconds`, plus one per `findPrice` the app does not cache |

Show where the price came from in health with an app check (see Monitoring, "App checks"):

```ts
// lib/price.ts: the display price, from Paddle by label, with the built-in amount as the fallback
let source = 'not read yet';
export async function scanPrice(): Promise<string> {
  try {
    const price = await cachedFindPrice(); // your cache around findPrice({ app: 'leakscan', key: 'scan', cycle: 'once' }, …)
    source = 'paddle';
    return formatPrice(price.amount, price.currency);
  } catch (error) {
    source = `fallback: ${error instanceof PriceError ? error.code : 'error'}`;
    return '$15';
  }
}
export const priceSource = () => source;

// lib/billing.ts
healthChecks: { price: async () => { await scanPrice(); return { ok: priceSource() === 'paddle', detail: priceSource() }; } },
```

## Shared seller accounts (`owns`)

All SnaxxTech apps use one Paddle seller account. A notification destination filters by event type, not by product. So each app receives the events of every product.

Tell the kit what this app sells. The kit then ignores the rest:

```ts
const { config } = readBillingEnv(process.env, { requiredPrices: ['team'] });
export const billing = config
  ? createBilling({ environment: config.environment, webhookSecret: config.webhookSecret, store, entitlements, owns: config.owns })
  : null;
```

How `owns` works:

- **Three forms.** `owns` is an object `{ priceIds?, productIds? }`, a function `({ kind, items, customData }) => boolean`, or (since v0.7.0) a resolver `{ resolve: () => Promise<ids | predicate> }`: `readBillingEnv` returns one with `resolvePrices` (see Find prices by their label), and an app with its own `owns` function builds one that returns that function. A resolver that throws, is slower than `hookTimeoutMs` or finds no id fails the event with 503 `prices_unavailable`; it never reads as "not ours" or "owns everything". Cache inside `resolve`: it runs for each event.
- **Default value.** `readBillingEnv` returns `config.owns = { priceIds: [each id in PADDLE_PRICES] }`. If the app also sells prices that are not in `PADDLE_PRICES`, add them: `owns: { priceIds: [...config.owns!.priceIds, 'pri_legacy'] }`.
- **The match.** An event is ours when **one or more** of its line items match.
- **Errors.** An `owns` object with no ids throws in `createBilling`, because it would ignore every event. A function that throws fails the event as `hook_error`.
- **Events that are not ours.** The kit answers 200 and records them as `ignored`, reason `not_ours`. They are not mirrored. No hook runs. They are not failures in health, and they write no warning to the log. They still update `lastEventAt`, so other products' traffic also shows that the webhook is alive.
- **Subscriptions you already have.** A subscription that is already in the mirror stays ours, also when a later event has none of our prices. A transaction on a mirrored subscription is also ours. When `owns` does not match such an event, the kit still processes it as before, but records it with reason `mirrored`.
- **Refunds (adjustments).** Adjustments have no price ids. The kit keeps each transaction it sees, with its owner, in `paddle_transactions`. So the kit records an adjustment of another app's transaction as `not_ours`.
- **Refunds for a transaction that the kit never saw.** The kit does **not** drop them. It gives them to `onAdjustment` with `ctx.known === false`, because a refund can arrive before its payment. Your app decides what to do. AppCare keeps it as a resolved `refund_unmatched` row, and its payment code checks for that row.
- **Other apps' refunds reach your `onAdjustment` too.** On a shared seller account, a refund of another app's transaction that this app never saw arrives with `ctx.known === false`. Record it; do not act on it (no access change, no email).
- **`reconcile`.** It lists every subscription on the account, but mirrors only ours (and the ones already mirrored). It returns `{ scanned, applied, notOurs, invalid }`.
- **No `owns`.** Every event is ours. Use this only when the app has its own seller account. `ctx.known` still tells you if the transaction was seen.

**When a price list is not enough, use a function.** AppCare must see a sale that has its own `order_id` but a wrong price, so that a person can check it. A price list would ignore that sale. So AppCare uses this function:

```ts
owns: ({ items, customData }) =>
  items.some((i) => i.priceId === fullScanPriceId) || (typeof customData?.order_id === 'string' && customData.order_id.length > 0),
```

## One-time purchases and refunds (hooks)

`createBilling` takes two optional hooks:

- `onTransaction(tx, ctx)` runs on `transaction.completed` only. `transaction.paid` is recorded without a hook.
- `onAdjustment(adj, ctx)` runs on `adjustment.created` and `adjustment.updated`.

### When the hooks run

The kit calls a hook after it records the event and before it marks the event `processed`.

- **At least once, never exactly once.** A hook can run more than once for one event: a retry after a failure or a timeout runs it again, and a delivery that takes over an old claim runs it again. An old claim is one older than `eventLeaseSeconds` (default 60 s), which means the first attempt crashed. So every side effect must be idempotent: key it on `tx.transactionId` (or `adj.adjustmentId` + `adj.status`).
- **Not two times at the same moment (since v0.4.0).** While one delivery runs the hooks, other copies of the same event get **409 `{ "error": "in_progress" }`**. Paddle sends them again later, and then they are plain duplicates (200).
- **A hook that throws fails the event:** HTTP 500, reason `hook_error`. Paddle then sends the event again.
- **Keep hooks fast.** Paddle waits 5 s for an answer.
- **`hookTimeoutMs` (since v0.7.0).** A hook (or an `owns` function or resolver) that runs longer fails the event as `hook_error`, and Paddle retries. The hook is **not** cancelled: it may still finish, and the retry runs it again. Keep it below 5 s and well below `eventLeaseSeconds`. `storeTimeoutMs` does the same for each store call the kit makes (a timeout is a `store_error`). Both are off by default.
- **`onError(error, ctx)` (since v0.7.0)** gets the original error of a failed hook, `owns`, price lookup or store call, with `ctx.reason`, `ctx.eventId` and `ctx.eventType`. The kit's own log line has only the reason, because an error can carry secrets. What `onError` does or throws never changes the answer.

### Rules for the hooks

1. **`transaction.completed` also comes for each subscription renewal.** A one-time-purchase hook must check `tx.subscriptionId === null`.
2. **A refund comes in steps.** First `pending_approval`, then `approved` or `rejected`. Act on a refund (`adj.action === 'refund'`) **only when `adj.status === 'approved'`**. Key your change on `adj.adjustmentId` + `adj.status`. Find your order with `adj.transactionId`.
3. **`ctx.known` (v0.4.0).** It is `true` when this app saw the transaction as its own, or the adjustment is for a subscription in the mirror. It is `false` in these cases:
   - the refund came before its payment;
   - the payment is older than v0.4.0;
   - the store cannot record transactions.

   **Record a `known: false` refund. Never drop it.** For example, write a resolved review row. Then your payment code can refuse a payment that was already taken back.
4. **`custom_data` comes from the browser, so do not trust it.** Check the order with `tx.items` (`priceId`, `quantity`). The catalog price sets the amount.
5. **Do not compare amounts or currency with your list price.** Paddle can show a local price (EUR for a USD list price). Discounts and tax also change the amounts. Record `tx.currency`, `tx.subtotal` (before discount and tax) and `tx.total` (with tax). Amounts are strings in the lowest unit (cents).
6. **Give the item in one database transaction.** Insert the order and give the credits together. If you insert the order first and the grant then fails, the retry sees "already done", and the customer paid for nothing.
7. **Take back credits automatically only on an approved full refund.** `adj.type` is `'full'`, `'partial'` or `null`. A partial refund does not say which credits to take back, so put it in a review queue for a person. Never let a balance go below zero.
8. **Never drop a paid order without a record.** For an unknown price id or a missing user id, write a `reviews` row (a person then refunds or fulfils by hand). Do not only write a log line. Grant by quantity. Do not refuse `quantity !== 1`.

### Example

```ts
import type { BillingConfig } from 'paddle-kit/core';

type Tx = { query(text: string, params?: unknown[]): Promise<{ rows: any[] }> };
declare const db: { transaction<T>(fn: (q: Tx) => Promise<T>): Promise<T> };

// `db` is your Postgres client with real transactions (pg, @neondatabase/serverless Pool, PGlite, ...).
// Tables: orders(id PRIMARY KEY, user_id, credits, currency, total), refunds(id PRIMARY KEY, order_id UNIQUE),
//         reviews(id PRIMARY KEY, kind, detail), accounts(user_id PRIMARY KEY, credits CHECK (credits >= 0)).
const review = (q: Tx, id: string, kind: string, detail: string) =>
  q.query('INSERT INTO reviews (id, kind, detail) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, kind, detail]);

export function packHooks(packPriceId: string, creditsPerUnit = 5): Pick<BillingConfig, 'onTransaction' | 'onAdjustment'> {
  return {
    onTransaction: async (tx) => {
      if (tx.subscriptionId !== null) return; // a renewal or a subscription start, not a one-time purchase
      const userId = tx.customData?.userId; // untrusted, but a user can only pay for someone else
      const known = tx.items.length > 0 && tx.items.every((i) => i.priceId === packPriceId);
      // The order and the grant commit together or not at all: if anything throws, the whole transaction
      // rolls back, the hook throws, Paddle retries, and the retry grants. Never insert the order and grant in two steps.
      await db.transaction(async (q) => {
        if (typeof userId !== 'string' || !known) {
          // Paid, but not an order we fulfil automatically. Persist it (do not just log): refund or fulfil by hand.
          await review(q, `txn:${tx.transactionId}`, 'unfulfilled_order', `${tx.currency} ${tx.total}`);
          return;
        }
        const credits = creditsPerUnit * tx.items.reduce((n, i) => n + i.quantity, 0); // grant by quantity
        // The currency is recorded, not required: Paddle can localise the price (EUR for a USD list price).
        const ins = await q.query(
          'INSERT INTO orders (id, user_id, credits, currency, total) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id',
          [tx.transactionId, userId, credits, tx.currency, tx.total],
        );
        if (ins.rows.length === 0) return; // replay of a transaction already fulfilled
        await q.query(
          'INSERT INTO accounts (user_id, credits) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET credits = accounts.credits + EXCLUDED.credits',
          [userId, credits],
        );
      });
    },
    onAdjustment: async (adj) => {
      if (adj.action !== 'refund' || adj.status !== 'approved') return; // pending_approval, rejected, reversed: nothing to do yet
      await db.transaction(async (q) => {
        const order = (await q.query('SELECT id, user_id, credits FROM orders WHERE id = $1', [adj.transactionId])).rows[0];
        if (!order || adj.type !== 'full') {
          // A partial refund (or one for an order we do not know) does not say which credits to take back: a human decides.
          await review(q, `adj:${adj.adjustmentId}`, order ? 'partial_refund' : 'refund_unknown_order', `${adj.currency} ${adj.total}`);
          return;
        }
        const ins = await q.query('INSERT INTO refunds (id, order_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id', [adj.adjustmentId, order.id]);
        if (ins.rows.length === 0) return; // replay
        await q.query('UPDATE accounts SET credits = GREATEST(credits - $1, 0) WHERE user_id = $2', [order.credits, order.user_id]);
      });
    },
  };
}
```

Connect it with the price id from `readBillingEnv`. Do not use `JSON.parse(process.env.PADDLE_PRICES)` at module scope.

```ts
export const billing = config
  ? createBilling({ /* environment, webhookSecret, store, entitlements */ ...packHooks(config.prices.pack as string) })
  : null;
```

We ran this example against a real SQL database (PGlite), through the built package. Results:

- A database failure in the grant also removed the order. Paddle's retry then gave the credits one time.
- An unknown price made a review row.
- A EUR order with quantity 2 gave 10 credits.
- Two partial refunds did not change the balance.
- An approved full refund took the credits back one time, and never below zero.

## Plan state

`paddle-kit/plan` tells you what an account can do: exempt, paid, in trial or expired. It is a pure function, with no dependencies, and it is safe for edge runtimes.

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

- `exempt` wins over everything. Then `subscribed` wins.
- `launchAt: null` means "no launch grace": the trial starts at `startedAt`. It does **not** mean "billing is off".
- **`trialDays: 0` with a `launchAt` in the future gives `expired` immediately.** Check the launch (`now >= launchAt`, or a `BILLING_ENFORCE` flag) before you act on `expired`.
- **Apps with a free tier:** use `trialDays: 0`, and read `expired` as "free limits", not as a lockout. Only an app with no free tier locks users out on `expired`.

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
- With `resolvePrices: { app }` (since v0.7.0) `PADDLE_PRICES` may be unset and `PADDLE_API_KEY` is required. The result then also has `config.resolvePrices()`. See Find prices by their label. Without the option nothing changes, also not the types.

**Build `createBilling` only when `config` is not null.** `createBilling` throws on a missing secret. If you build it at module scope, `next build` breaks in each place where billing is not set up.

```ts
import { createBilling } from 'paddle-kit/core';

if (problems.length > 0) console.error('billing misconfigured:', problems.join('; ')); // loud, but only when partly set

export const billing = config
  ? createBilling({ environment: config.environment, webhookSecret: config.webhookSecret, store, entitlements, owns: config.owns })
  : null; // billing off: callers check for null and serve the free experience
```

## Catalog CLI

`paddle-kit-catalog` reads a JSON file and creates or updates a **sandbox** catalog in Paddle. It makes the product, the prices, the webhook destination and a client token. Then it writes the results to an env file. A second run with the same file changes nothing.

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
| `--catalog <path>` | The catalog JSON file. Default: `paddle.catalog.json`. |
| `--webhook-url <url>` | The **full URL** of your webhook route, with the path (for example `https://host/api/paddle`). Only `https`. It turns on the destination and client-token steps. Without it, the CLI syncs only the product and the prices. |
| `--env-file <path>` | The env file. The CLI reads `PADDLE_API_KEY` from it (after the process environment) and writes the results to it. Default: `.env.local`. The file gets mode 0600. The CLI writes each key when its step is done, and does not touch other lines. |
| `--teardown` | Archive the prices and the product that this tool made, and turn off its destination. |
| `--live` | Allow a live (`pdl_live_`) key. Without this flag, the CLI refuses all keys except sandbox keys. |
| `--host vercel` | Also print the `vercel env add` commands for the host block (since v0.6.0). The CLI never runs them. |
| `--show-secrets` | Print the webhook secret in the host block. Without it, the secret is a comment that shows only its last 4 characters. |

What you must know:

- **What it writes to the env file.** It always writes `PADDLE_ENV` and `PADDLE_PRICES`. With `--webhook-url`, it also writes `PADDLE_NOTIFICATION_WEBHOOK_SECRET` (read from the destination, so you never copy it by hand) and `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`. In `PADDLE_PRICES`, a key maps to `{ cycle: price id }` for each cycle in the catalog. A key with only a `once` price maps to one id.
- **The destination's traffic (since v0.7.0).** Sandbox: `traffic_source: "all"`, so the webhook simulator reaches the app. **Live: `"platform"`**, real events only, so no simulated event (signed with the real secret, sent by anyone with dashboard access) can reach an app that grants real access. A re-run moves an existing destination to the right value (0.6.x made live destinations with `"all"`).
- **Markers.** The product has `custom_data.paddle_kit = "<app>"`. Each price has `custom_data.paddle_kit_price = "<key>-<cycle>"`. The destination description is `"<app> (paddle-kit)"`. The CLI finds its own resources only with these markers. It never touches other resources. On teardown, it keeps a product that has prices from other sources. A changed `amount` updates only that price.
- **Live and test never mix.** Before it sends a request, the CLI refuses: a live key without `--live`; `--live` with a sandbox key; and a live run (except `--teardown`) when the env file has a `test_` client token.
- **After `--teardown`,** `PADDLE_PRICES` in the env file still points to the archived prices. Remove it or make it again before the app reads it.
- The CLI never shows the key. It removes the key from all output and error messages.
- A top-level `"$schema"` string in the catalog JSON is allowed, and the CLI ignores it.
- **The host block (since v0.6.0).** After each run (except `--teardown`), the CLI prints the variables that the deployed app needs, from the env file: `PADDLE_ENV`, `PADDLE_PRICES`, `PADDLE_NOTIFICATION_WEBHOOK_SECRET` and `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`. Paste it into your host (sandbox: Preview and Development; `--live`: Production). The secret is a commented line unless you pass `--show-secrets`, so a pasted block never sets a placeholder as the secret: the deployed app then reports the missing variable instead. Never paste the block into a chat or a ticket with `--show-secrets`.
- With `--host vercel`, the block also has one `printf '%s' '<value>' | vercel env add <NAME> <environment>` line per variable and environment, and `vercel env add <NAME> <environment>` (it asks for the value) for the hidden secret. **UNVERIFIED:** we did not run these commands against a real Vercel project. Check that `vercel env add … preview` from a pipe does not ask for a Git branch in your Vercel CLI version.
- The CLI prints the four variables that it writes. It also lists, as a comment, the ones that it cannot know: `PADDLE_API_KEY` (only if the app uses `reconcile` or `getPrice`), `PADDLE_HEALTH_TOKEN`, `BILLING_LAUNCH_AT` and `BILLING_ENFORCE`.

## Moving an app that already has a catalog

The CLI finds resources only by its own markers. It cannot see a catalog from an older script. If you run the CLI next to that catalog, you get a **second product and a second destination**. Two destinations on one URL both send events, each signed with a different secret. One of them always fails with `signature_mismatch`.

Example (Offday): its old script used the markers `offday` / `offday_price` and the destination `Offday (sandbox)`. Before the first CLI run, do one of these:

1. Run the old script's teardown. It archives the old prices and product, and turns off the old destination.
2. Or turn off the old destination in the Paddle dashboard (Developer tools > Notifications), and archive the old catalog by hand.

Then run the CLI. Replace `PADDLE_PRICES` and `PADDLE_NOTIFICATION_WEBHOOK_SECRET` in the app with the new values. After that, make sure that exactly one active destination points to your URL.

Existing subscriptions on archived prices should continue to renew. Only new checkouts need the new price ids. **UNVERIFIED:** confirm this in sandbox before you archive a live catalog.

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

## Monitoring

**The health route.** Set `healthToken` to turn it on. Use `GET` on the same path, with the header `Authorization: Bearer <token>`.

- Without `healthToken`, the route answers 404. With a wrong token, it answers 401.
- If the store is down, the route answers **503 `{ "error": "store_error" }`** and writes `store_error` to the log. It does not throw.
- The token is compared in constant time after hashing both sides (since v0.7.0), so neither its content nor its length leaks through timing.
- There is no pinger. The signal comes from real webhook traffic.

**The main "alive" signal is `lastEventAt`.** If no verified event arrives for longer than your normal gap between events, find out why. Other products' events also count (see `owns`). A wrong webhook secret shows here: no event is verified, so `lastEventAt` goes old. `paddle-kit-doctor --stale-hours` (or `staleHours` in an apps file) turns that into a problem.

**Requests refused before the signature check never touch the store (since v0.7.0).** A missing or oversized body, a missing or bad signature, and a timestamp out of the window are answered 400/401/413 and counted in **the server instance's memory** (`unverified` in health), with at most one warn log line a minute (`count` = refusals since the last line). Anyone can send these requests: before v0.7.0 each one wrote a `paddle_failures` row, so a bot hitting the URL kept a serverless Postgres (Neon) awake. The count starts again when the instance restarts, and each instance has its own: on serverless hosts the instance that answers the health GET may not be the one that refused the request. Only signed requests (`bad_json`, `bad_payload`) and failed events are still written to the store.

| Field | Meaning |
|---|---|
| `lastEventAt` | When the last verified event arrived (processed, ignored or stale). `null` if there is none yet. |
| `lastFailureAt` | The time of the last failure: a failed event, or a signed request refused as `bad_json` / `bad_payload`. Since v0.7.0 not a refusal before the signature check (see `unverified`). |
| `lastFailureReason` | Our own reason code for it. Never secret text, never driver text. |
| `failedLast24h` | Failed events plus refused signed requests in the last 24 hours. |
| `unlinkedLast24h` | Subscription events with no `userId` (stored with `user_id = NULL`, reason `no_user_id`). To fix, open each checkout with `createCheckout`, which sets `customData.userId`. |
| `lastOwnedAt` | When the last event that `owns` matched arrived: a processed event with reason `null` or `no_user_id`. Events with reason `mirrored` or `unmatched`, and late (`out_of_order`) deliveries, do not count. Without `owns`, every event matches. `null` if there is none yet. Since v0.5.0. |
| `notOursLast24h` | Events acked as `not_ours` in the last 24 hours (other products on a shared seller account). Since v0.5.0. |
| `kitVersion` | The paddle-kit version that the app runs, for example `"0.5.0"`. Added by the route, not by the store. Since v0.5.0. |
| `environment` | `sandbox` or `production`, from `createBilling`. Added by the route, not by the store. Since v0.5.0. |
| `unverified` | `{ since, count, byReason, lastAt, lastReason }`: requests refused before the signature check, counted in the memory of the instance that answers, since `since` (its start). Added by the route. Since v0.7.0. |
| `checks` | `{ [name]: { ok, detail? } }`, one per `healthChecks` entry; only when you set `healthChecks`. Since v0.7.0. |

**App checks (since v0.7.0).** `createBilling({ healthChecks: { price: async () => ({ ok: true, detail: 'paddle' }) } })`. The checks run only on the authenticated health route, all at the same time, each within `healthCheckTimeoutMs` (default 3000). A check that throws, times out or returns no `{ ok }` is `{ ok: false }` with a short detail, and `onError` gets the thrown error; the error text never reaches the report. `detail` is shown as you return it: never put a secret in it. A failed check makes `paddle-kit-doctor` exit 1. Example: Find prices by their label, "Show where the price came from".

**Alert rule for a wrong `owns`:** `lastOwnedAt` older than N days (your longest normal gap between your own sales or renewals) **and** `notOursLast24h > 0` = your `owns` is wrong. Paddle's events still arrive, but the kit sends all of them to `not_ours`, so `lastEventAt` stays fresh and `failedLast24h` stays 0. On a shared seller account `notOursLast24h > 0` alone is normal traffic; do not alert on it.

Limits of this rule:

- It catches an `owns` that matches none of your traffic. If `owns` misses only one new price while other prices in `owns` still sell or renew, `lastOwnedAt` stays fresh, and the rule stays quiet.
- A refund of a one-time purchase that was ours before `owns` broke still counts (the kit uses the stored owned flag), so steady refunds of older purchases can delay the alert by up to your refund window plus N days.
- The trade-off: if all of an app's paying subscribers are on a retired price that is no longer in `owns`, their renewals are `mirrored`, and the rule gives a false alarm. Add the retired price to `owns`.
- v0.4.0 recorded refunds of transactions it never saw, `customer.*` events and events kept only because their subscription was mirrored with reason `null`. Such rows count in `lastOwnedAt` until they are older than your N days.

**Deploy check: `paddle-kit-doctor` (since v0.6.0).** It calls the health route of a deployed app and says in plain words what is wrong:

```bash
npx paddle-kit-doctor --url https://app.example.com/api/paddle --token "$PADDLE_HEALTH_TOKEN"
```

- `--token` defaults to the `PADDLE_HEALTH_TOKEN` environment variable, so you can keep the token out of your shell history. The token is never printed.
- It shows: reachable or not, billing on or off, the environment and kit version, the env problems by name, the last event time, and the last failure reason with its meaning (for example `signature_mismatch`: the webhook secret on the host does not match the destination).
- **Exit 1 on a problem:** not reachable, a redirect (it does not follow it), a refused token, billing off, the health route off, misconfigured, `store_error`, a `signature_mismatch`, `store_error`, `hook_error` or `prices_unavailable` in the last 24 hours, a failed app check, or (with `--stale-hours <h>`) no verified event for more than `h` hours. Other failure reasons (often bots) and "no event yet" are shown, but exit 0.
- Since v0.7.0 it also shows the `unverified` refusals of the instance that answered. A `signature_mismatch` among them is a WARNING, not a problem: a bot can send one too. If Paddle sent it, no event is verified any more, and `--stale-hours` catches that.
- The problem names and `billing_off` / `health_off` need a route made with `createWebhookRoute` (v0.6.0). For the names, pass `healthToken` to it. An older route answers a plain 404 or 503, and the doctor says what that can mean.
- `https` only (http only for `localhost`), because the token is in the request. Timeout: `--timeout <ms>`, default 10000.

**Every app in one run: `paddle-kit-doctor --apps apps.json` (since v0.7.0).** For a scheduled job (the plan: a private `SnaxxTech/billing-watch` repository runs it every 6 hours from GitHub Actions and keeps one issue open per red app).

```jsonc
// apps.json: names, URLs and the NAME of each token's variable. Never a token: an entry with "token" is refused.
[
  { "name": "leakscan", "url": "https://leakscan.app/api/paddle", "tokenEnv": "LEAKSCAN_HEALTH_TOKEN", "staleHours": 48 },
  { "name": "offday",   "url": "https://offday.app/api/paddle",   "tokenEnv": "OFFDAY_HEALTH_TOKEN",   "staleHours": 24 }
]
```

```bash
LEAKSCAN_HEALTH_TOKEN=… OFFDAY_HEALTH_TOKEN=… npx paddle-kit-doctor --apps apps.json
```

```text
APP       RESULT   REACHABLE  ENV  LAST EVENT                FAILED 24H  CHECKS
leakscan  OK       yes        ok   3 h ago                   0           price ok
offday    PROBLEM  yes        ok   3 days ago STALE (>24 h)  0           -
offday: PROBLEM: no verified event for more than 24 h: check the webhook secret and the Paddle notification destination
Result: PROBLEM in offday (exit 1)
```

- The apps are checked at the same time, each with its own timeout. An app whose token variable is not set is red without a request.
- `staleHours` (optional, per app) is the longest normal gap between verified events for that app. Unset: age is shown, not judged.
- **`--json`** prints `{ ok, checkedAt, apps: [...] }`. Each app has `name`, `url`, `tokenEnv` (the variable's name, never its value), `ok`, `reachable`, `httpStatus`, `billing` (`on`, `off`, `health_off`, `misconfigured` or `null`), `environment`, `kitVersion`, `envProblems`, `lastEventAt`, `lastEventAgeHours`, `staleHours`, `stale`, `lastOwnedAt`, `failedLast24h`, `lastFailureReason`, `lastFailureAt`, `unverifiedCount`, `checks` and `problems` (plain words; empty when `ok`). A job opens or updates one issue per app with `ok: false` and closes it when the app is `ok` again.
- **Exit codes:** 0 every app green; 1 one or more apps red; **2 the apps file or the flags are wrong, and nothing was checked**: a job must not close issues on exit 2.
- A token is never printed, in the table or the JSON. `--apps` takes no `--url`, `--token` or `--stale-hours`.

**Rotate the webhook secret without downtime (since v0.7.0).** Paddle gives each destination its own secret. To change it, make a second destination for the same URL (its secret is new), and put both secrets in `PADDLE_NOTIFICATION_WEBHOOK_SECRET`, separated by a comma: `pdl_ntfset_old,pdl_ntfset_new`. Pass `webhookSecret: config.webhookSecrets ?? config.webhookSecret` (`createBilling` takes an array). Deploy. Both destinations now deliver each event, and the ledger keeps one (same `event_id`). Turn off the old destination, remove the old secret, deploy again. **UNVERIFIED** against real Paddle: that two destinations send the same `event_id`.

**Reason codes:** `missing_body`, `body_too_large`, `bad_signature_header`, `signature_mismatch`, `stale_timestamp`, `future_timestamp`, `bad_json`, `bad_payload`, `unknown_event`, `no_user_id`, `out_of_order`, `store_error`, `hook_error`, `not_ours`, `unmatched`, `mirrored`, `prices_unavailable`.

- `future_timestamp` (v0.7.0) is a 401 for a signature whose timestamp is more than `clockSkewSeconds` (default 60) ahead of the server clock: the server's clock is behind, or a request was made to be replayed later. The past side stays 5 s (`stale_timestamp`). Both are checked only after the signature matched, and both are counted in `unverified`, not in the store.
- `prices_unavailable` (v0.7.0) is a 503 when an `owns` resolver could not find the app's price ids. The event is marked `failed` and Paddle retries; it is never recorded as `not_ours`.

- `not_ours` (v0.4.0) is `ignored`. It is never a failure.
- `body_too_large` is a 413 for a body over `maxBodyBytes` (default 4 MB, `MAX_WEBHOOK_BODY_BYTES`, just under Vercel's request limit). The kit stops reading at the cap, before it checks the signature, and counts the request in `unverified` (in `failedLast24h` before v0.7.0). A Paddle event is a few KB plus about 2 KB per line item. If you lower the cap, keep it far above your largest transaction: Paddle retries a refused event and then drops it.
- `unmatched` (v0.5.0) is `processed`, but `owns` never matched it: an adjustment with `ctx.known === false` (on a shared seller account it can be another app's refund). The hook ran. It is not a failure and writes no log line. It does not count in `lastOwnedAt`.
- `mirrored` (v0.5.0) is `processed` only because its subscription is already in the mirror; `owns` did not match it. An adjustment of such a subscription is `mirrored` too. The hook ran. It is not a failure and writes no log line. It does not count in `lastOwnedAt`.
- A 409 `in_progress` answer is not a failure. It is not logged or counted. Paddle's next try becomes a 200 duplicate.
- Log lines contain only `reason`, `eventId`, `eventType` and (for the once-a-minute line about refused requests) `count`. They never contain the body, the signature header or secrets.

**`failedLast24h` is approximate.** The kit counts refused signed requests (and failures with no event row) per minute and per reason. A minute counts if its last hit is in the 24-hour window. So the number can be too high by one minute of hits at the edge of the window.

**Failures that recover disappear.** A `hook_error` or `store_error` event counts in health only while it is `failed`. When Paddle's retry works, the event becomes `processed`, and it is no longer in `lastFailureAt` or `failedLast24h`. A refused signed request (bad JSON, bad payload) gets no retry, so it stays for 24 hours. A clean health after an incident means "recovered", not "nothing happened". Look in your logs for `hook_error`.

**Retries.** Paddle sends the event again after each answer that is not 2xx:

| Account | Retries |
|---|---|
| Live | up to 60 tries in about two days (about 10 in the first hour, about 45 in the first day) |
| Sandbox | 3 tries within about two minutes |

Source: Paddle, [Respond to webhooks](https://developer.paddle.com/webhooks/respond-to-webhooks), read 2026-10-29. In sandbox a broken endpoint loses an event within minutes, so watch the first deliveries.

After the last try, Paddle drops the event. So you must see a broken endpoint during that time. After an outage, run `reconcile` from an existing cron job:

```ts
import { reconcile } from 'paddle-kit/reconcile';
await reconcile(billing, { apiKey: process.env.PADDLE_API_KEY! }); // { scanned, applied, notOurs, invalid }
```

How `reconcile` works:

- It reads `GET /subscriptions` with `fetch`, 200 per page. It follows Paddle's pages and never goes to a different host.
- It uses the same `subscriptionFrom()` as the webhook path. So a reconciled row is equal to the webhook row (snake_case `raw`, the same status and `userId` checks).
- Each row has the API's `updated_at`, so a later webhook still wins.
- `invalid` counts the subscriptions that the webhook path would also refuse.
- It is safe for edge runtimes. To use your own `fetch`, pass `fetch`.

The webhook path only writes to your store. It never calls the Paddle API, because Paddle waits only 5 seconds; the one exception is an `owns` resolver (`resolvePrices`), which looks the prices up once per `cacheSeconds` per instance. The signature clock check allows 5 seconds (the `signatureToleranceSeconds` option was removed in v0.4.0).

**Note:** a slow cold start can use up the 5 seconds. In local testing, a dev server that compiled for 4.5 s refused the first event with 401 `stale_timestamp`. Paddle sends the event again, so this costs one retry, not the event.

## Integration checklist

Do these steps one time for each app: first in sandbox, then again for live.

1. **Set the default payment link (dashboard only).**
   1. In the Paddle dashboard, open Paddle > Checkout > Checkout configuration.
   2. Set the *default payment link* to a public `https` URL of your app: the page that calls `createCheckout`. Paddle refuses `localhost`.
   3. **Do this in sandbox and in live.** They are different accounts. Without the link, checkout fails with `transaction_default_checkout_url_not_set`.
   4. Start Paddle.js when that page loads (for example, call `createCheckout` in an effect on mount, not only in a button click). Paddle opens a checkout link from the `_ptxn` query parameter when the page loads.

   We found no API for this setting (**UNVERIFIED** that there is none).
2. **Install the kit in the app:** `npm i github:SnaxxTech/paddle-kit#v0.7.0`. The kit is not on the npm registry, so run the CLIs in the app folder (or see Install for `npx --package=…`).
3. **Make the catalog.** Run `npx paddle-kit-catalog --webhook-url https://<host>/api/paddle` (see Catalog CLI). Read the table that it shows. Never copy the webhook secret by hand.
4. **Put the variables on the host.** Paste the host block that the CLI prints (`--host vercel` prints the commands). Add `PADDLE_HEALTH_TOKEN` (any long random value), and `PADDLE_API_KEY` if the app uses `getPrice`, `findPrice`, `resolvePrices` or `reconcile`. Redeploy.
5. **Add the code:** `lib/billing.ts` with `readBillingEnv`, the route file with `createWebhookRoute` and the checks with `hasAccess` (see Next.js example). Pass `onError` so a failure's cause reaches your error tracker. Optional: show the price with `findPrice` or `getPrice` (see Show the price from Paddle), so that the price lives only in Paddle, and report its source with a `healthChecks` entry. A one-time-purchase app may drop `PADDLE_PRICES` with `resolvePrices` (see Find prices by their label).
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

## Known issues (still open in v0.7.0)

- **The past_due grace period can move.** The kit calculates the grace start from the stored row.
  - Two `past_due` events at the same time can make the grace longer, by the time between them.
  - A lost or late recovery event can join two `past_due` periods into one. Then the grace ends too early, and the customer loses access.
  - `reconcile` does **not** correct this, because it keeps the stored value.
  - Fix it by hand: `UPDATE paddle_subscriptions SET past_due_since = '<first past_due time>' WHERE subscription_id = '<sub_id>'`. Or wait until the subscription is no longer `past_due`.
- **Health does not count stored failures per reason.** `failedLast24h` is one total, and health shows only the last reason. (`unverified.byReason` does count refusals per reason, per instance.)
- **`unverified` is per instance and resets on restart.** On a serverless host, health may be answered by an instance that saw none of the refused requests. Judge a wrong secret by `lastEventAt`, not by `unverified`.

## What we tested, and what we did not

**Tested:**

| Date | Version | What we did | Result |
|---|---|---|---|
| 2026-10-16 | v0.1 | Real Paddle simulator events, through a tunnel, into the kit on Postgres (PGlite) | A subscription gave access. `past_due` kept access and started the grace clock. `canceled` removed access. A wrong secret gave 401 and `signature_mismatch` in health. `reconcile` worked against the real sandbox API. |
| 2026-10-16 | v0.2 | Offday: a real sandbox subscription checkout with the test card | Access turned on. An immediate cancel turned it off. |
| 2026-10-16 | v0.3 | A real one-time checkout ($5 + VAT) | `onTransaction` ran one time, on `transaction.completed`, with `subscriptionId: null`, the checkout's `customData`, `items`, `subtotal` 500 and `total` 590. |
| 2026-10-16 | v0.3 | A real full refund through the API | `onAdjustment` ran two times: `adjustment.created` (`pending_approval`, `type: full`), then about 7 minutes later `adjustment.updated` (`approved`, `type: full`). |
| 2026-10-16 | v0.3 | Catalog CLI on the real sandbox | It made a catalog, did nothing on a second run, and its teardown removed only its own resources. It also moved Offday's old catalog. |
| 2026-10-17 | v0.4 | Test suite on a real Postgres 17.10 server (`embedded-postgres`) | 305 of 305 tests pass. 50 parallel copies of one event run the hook one time. A load of 1,000 events gave 0 errors. |
| 2026-10-29 | v0.7 | Test suite, plus the real-Postgres suite on Postgres 17.10 (`embedded-postgres`) | 405 of 405 tests, and 5 of 5 on real Postgres (1,000 events: 0 errors, 1,000 of 1,000 samples counted). 500 unsigned and forged POSTs made 0 store calls (v0.6.0 made one `recordFailure` per request). |
| 2026-10-29 | v0.7 | The packed tarball in a scratch app (`npm run smoke`), and the built `paddle-kit-doctor --apps` against two local health routes (real `fetch`, a real apps file) | Smoke passed. The doctor printed the table and the JSON, exited 1 for the misconfigured app and 0 for the healthy one in single-app mode, and printed no token. |

Test fixtures are the real payloads that we captured (see `tests/fixtures/SOURCES.md`).

**Not tested (UNVERIFIED):**

- A real renewal, and whether `current_billing_period` moves forward when a renewal fails. The simulator's demo subscription has a fixed period.
- A partial refund and a chargeback from real Paddle.
- Subscriptions that renew on archived prices.
- v0.4.0 with real sandbox events. The v0.4.0 tests used signed test events, not events from Paddle.
- v0.7.0 against real Paddle: the live destination's move to `traffic_source: platform`, `findPrice` / `resolvePrices` against the real price list, and two destinations sending the same `event_id` during a secret rotation. All used a fake Paddle API.
- `unverified` on a real serverless host (how often the health GET reaches the instance that refused a request).
- A deploy to a real edge host. `npm run check:edge` checks API use only, not the problems of each host.
- The Neon HTTP driver.

## Kosovo payout note

**UNVERIFIED:** can Paddle pay out to a seller in Kosovo? Paddle's sanctions page does not list Kosovo as excluded, and payouts can be in EUR. But no official statement says that Paddle pays a Kosovo seller. Ask Paddle (support, or a completed seller verification) before you use live keys. Work in sandbox is not affected.

## Scripts

| Command | What it does |
|---|---|
| `npm test` | All tests. |
| `npm run test:pg` | Only the real-Postgres tests (parallel events and load). Without a Postgres server, it shows a loud SKIP line and passes. It uses `embedded-postgres`, or `pg` with `PADDLE_KIT_PG_URL`. |
| `npm run typecheck` | TypeScript check. |
| `npm run build` | Builds `dist/`. |
| `npm run check:edge` | Checks that the edge-safe bundles use no Node-only APIs. |
| `npm run smoke` | Packs the package, installs it in a temporary folder, imports each subpath and sends signed test events (`owns` filter, known and unknown refund, a forged POST counted in memory and shown in health with an app check). |
| `bash scripts/release.sh X.Y.Z` | Runs all checks, builds `dist/` into a release commit and tags it. Pushing the tag is a separate step. |

**CI is on** (since v0.5.0): `.github/workflows/ci.yml` runs the type check, the tests, the build, the edge check, the packed-tarball smoke check and the real-Postgres suite on each push and pull request.

## Claude Code skill

`skills/integrating-paddle-kit/SKILL.md` tells an AI agent how to add the kit to an app: the decisions, the order of work, the sandbox test and the traps. Install it one time on each computer, and every project can use it:

```bash
ln -sfn ~/Desktop/Projects/paddle-kit/skills/integrating-paddle-kit ~/.claude/skills/integrating-paddle-kit
```

Then ask Claude Code to "add Paddle billing with paddle-kit" in any app. We tested the skill before we shipped it. Agents without it got 9–11 of 14 points on our integration checklist. With the skill, they got 13 of 14 (16 of 17 on the longer checklist).
