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
| Create products and prices in Paddle | `npx paddle-kit-catalog` reads a JSON file |
| Open the checkout in the browser | `createCheckout()` in `paddle-kit/client` |
| Repair after an outage | `reconcile()` copies subscriptions from the Paddle API |

What it does **not** do: in-app purchases in mobile store apps. Google Play and the App Store require their own billing for digital goods. Paddle is for web checkout only.

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
npm i github:SnaxxTech/paddle-kit#v0.4.0
```

- The repository is private. CI and the host need a read token (see the Integration checklist, step 4).
- `memoryStore` (`paddle-kit/memory`) is for tests and local development only. It keeps data in memory, and it is not shared between server instances. Use `postgresStore` or `sqliteStore` in production.
- The only optional peer dependency is `@paddle/paddle-js`. You need it only for `paddle-kit/client` (the browser checkout).
- `reconcile` and the catalog CLI call the Paddle REST API with `fetch`. You do not need the Paddle Node SDK (since v0.4.0).

## Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `PADDLE_ENV` | server | `sandbox` or `production`. |
| `PADDLE_NOTIFICATION_WEBHOOK_SECRET` | server | The secret key of the notification destination. Required: `createBilling` throws if it is missing or empty. `billing.config` never contains it. |
| `PADDLE_API_KEY` | `reconcile`, catalog CLI | `pdl_sdbx_...` for sandbox, `pdl_live_...` for production. A key that does not agree with `PADDLE_ENV` throws. Keys without these prefixes are refused. |
| `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` | browser | `test_...` for sandbox, `live_...` for production. A token that does not agree with the environment throws in `createCheckout`. |
| `PADDLE_PRICES` | server | A JSON price map, for example `{ "team": { "monthly": "pri_..", "yearly": "pri_.." }, "pack": "pri_.." }`. The catalog CLI writes it. `readBillingEnv` checks it. |
| `BILLING_LAUNCH_AT` | server | Optional. The launch time, in ISO format with a timezone. |
| `BILLING_ENFORCE` | server | Optional. Enforcement is on only when the value is exactly `1`. |
| `PADDLE_HEALTH_TOKEN` | server | Optional. Turns on the health route (see Monitoring). |

`readBillingEnv` (below) checks all of these at the same time. It names the bad variable, so that you do not get an error later.

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

In a real app, build `billing` only when the env is valid. See "Env validation" below.

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
        checkout.open({ items: [{ priceId: 'pri_01abc', quantity: 1 }], userId, email });
      }}
    >
      Upgrade
    </button>
  );
}
```

Always open the checkout with `createCheckout(...).open(...)`. It sets `customData.userId`, and the kit uses this value to link a subscription to your user. `open` throws if `userId` is empty.

`app/dashboard/page.tsx` (server component)

```tsx
import { billing } from '@/lib/billing';

export default async function Dashboard() {
  const userId = await getCurrentUserId(); // your auth
  const pro = await billing.hasAccess(userId, 'pro');
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

- **Two forms.** `owns` is an object `{ priceIds?, productIds? }`, or a function `({ kind, items, customData }) => boolean`.
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

- **At least one time.** A retry after a failure runs the hook again. A delivery that takes over an old claim also runs it again. An old claim is one older than `eventLeaseSeconds` (default 60 s), which means the first attempt crashed.
- **Not two times at the same moment (since v0.4.0).** While one delivery runs the hooks, other copies of the same event get **409 `{ "error": "in_progress" }`**. Paddle sends them again later, and then they are plain duplicates (200).
- **A hook that throws fails the event:** HTTP 500, reason `hook_error`. Paddle then sends the event again.
- **Keep hooks fast.** Paddle waits about 5 s for an answer.

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
| All are good | `config` has the values. `config.owns` holds every price id from `PADDLE_PRICES`. |

- `PADDLE_ENV` is `sandbox` when it is not set.
- `test_` and `pdl_sdbx_` credentials go with sandbox. `live_` and `pdl_live_` credentials go with production.
- An unknown `PADDLE_ENV` is reported one time only.

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

What you must know:

- **What it writes to the env file.** It always writes `PADDLE_ENV` and `PADDLE_PRICES`. With `--webhook-url`, it also writes `PADDLE_NOTIFICATION_WEBHOOK_SECRET` (read from the destination, so you never copy it by hand) and `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`. In `PADDLE_PRICES`, a key maps to `{ cycle: price id }` for each cycle in the catalog. A key with only a `once` price maps to one id.
- **Markers.** The product has `custom_data.paddle_kit = "<app>"`. Each price has `custom_data.paddle_kit_price = "<key>-<cycle>"`. The destination description is `"<app> (paddle-kit)"`. The CLI finds its own resources only with these markers. It never touches other resources. On teardown, it keeps a product that has prices from other sources. A changed `amount` updates only that price.
- **Live and test never mix.** Before it sends a request, the CLI refuses: a live key without `--live`; `--live` with a sandbox key; and a live run (except `--teardown`) when the env file has a `test_` client token.
- **After `--teardown`,** `PADDLE_PRICES` in the env file still points to the archived prices. Remove it or make it again before the app reads it.
- The CLI never shows the key. It removes the key from all output and error messages.
- A top-level `"$schema"` string in the catalog JSON is allowed, and the CLI ignores it.

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
- There is no pinger. The signal comes from real webhook traffic.

**The main "alive" signal is `lastEventAt`.** If no verified event arrives for longer than your normal gap between events, find out why. Other products' events also count (see `owns`). `failedLast24h` also counts requests from bots on a public URL, so a number above 0 alone does not show an outage.

| Field | Meaning |
|---|---|
| `lastEventAt` | When the last verified event arrived (processed, ignored or stale). `null` if there is none yet. |
| `lastFailureAt` | The time of the last failure (a refused request or a failed event). |
| `lastFailureReason` | Our own reason code for it. Never secret text, never driver text. |
| `failedLast24h` | Refused requests plus failed events in the last 24 hours. |
| `unlinkedLast24h` | Subscription events with no `userId` (stored with `user_id = NULL`, reason `no_user_id`). To fix, open each checkout with `createCheckout`, which sets `customData.userId`. |
| `lastOwnedAt` | When the last event that `owns` matched arrived: a processed event with reason `null` or `no_user_id`. Events with reason `mirrored` or `unmatched`, and late (`out_of_order`) deliveries, do not count. Without `owns`, every event matches. `null` if there is none yet. Since v0.5.0. |
| `notOursLast24h` | Events acked as `not_ours` in the last 24 hours (other products on a shared seller account). Since v0.5.0. |

**Alert rule for a wrong `owns`:** `lastOwnedAt` older than N days (your longest normal gap between your own sales or renewals) **and** `notOursLast24h > 0` = your `owns` is wrong. Paddle's events still arrive, but the kit sends all of them to `not_ours`, so `lastEventAt` stays fresh and `failedLast24h` stays 0. On a shared seller account `notOursLast24h > 0` alone is normal traffic; do not alert on it.

Limits of this rule:

- It catches an `owns` that matches none of your traffic. If `owns` misses only one new price while other prices in `owns` still sell or renew, `lastOwnedAt` stays fresh, and the rule stays quiet.
- A refund of a one-time purchase that was ours before `owns` broke still counts (the kit uses the stored owned flag), so steady refunds of older purchases can delay the alert by up to your refund window plus N days.
- The trade-off: if all of an app's paying subscribers are on a retired price that is no longer in `owns`, their renewals are `mirrored`, and the rule gives a false alarm. Add the retired price to `owns`.
- v0.4.0 recorded refunds of transactions it never saw, `customer.*` events and events kept only because their subscription was mirrored with reason `null`. Such rows count in `lastOwnedAt` until they are older than your N days.

**Reason codes:** `missing_body`, `body_too_large`, `bad_signature_header`, `signature_mismatch`, `stale_timestamp`, `bad_json`, `bad_payload`, `unknown_event`, `no_user_id`, `out_of_order`, `store_error`, `hook_error`, `not_ours`, `unmatched`, `mirrored`.

- `not_ours` (v0.4.0) is `ignored`. It is never a failure.
- `body_too_large` is a 413 for a body over `maxBodyBytes` (default 4 MB, `MAX_WEBHOOK_BODY_BYTES`, just under Vercel's request limit). The kit stops reading at the cap, before it checks the signature, and counts the request in `failedLast24h`. A Paddle event is a few KB plus about 2 KB per line item. If you lower the cap, keep it far above your largest transaction: Paddle retries a refused event and then drops it.
- `unmatched` (v0.5.0) is `processed`, but `owns` never matched it: an adjustment with `ctx.known === false` (on a shared seller account it can be another app's refund). The hook ran. It is not a failure and writes no log line. It does not count in `lastOwnedAt`.
- `mirrored` (v0.5.0) is `processed` only because its subscription is already in the mirror; `owns` did not match it. An adjustment of such a subscription is `mirrored` too. The hook ran. It is not a failure and writes no log line. It does not count in `lastOwnedAt`.
- A 409 `in_progress` answer is not a failure. It is not logged or counted. Paddle's next try becomes a 200 duplicate.
- Log lines contain only `reason`, `eventId` and `eventType`. They never contain the body, the signature header or secrets.

**`failedLast24h` is approximate.** The kit counts refused requests per minute and per reason. A minute counts if its last hit is in the 24-hour window. So the number can be too high by one minute of hits at the edge of the window.

**Failures that recover disappear.** A `hook_error` or `store_error` event counts in health only while it is `failed`. When Paddle's retry works, the event becomes `processed`, and it is no longer in `lastFailureAt` or `failedLast24h`. A refused request (bad signature, bad JSON) gets no retry, so it stays for 24 hours. A clean health after an incident means "recovered", not "nothing happened". Look in your logs for `hook_error`.

**Retries.** Paddle sends the event again after each answer that is not 2xx:

| Account | Retries |
|---|---|
| Live | 60 tries in about 3 days |
| Sandbox | 3 tries in about 15 minutes |

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

The webhook path only writes to your store. It never calls the Paddle API, because Paddle waits only about 5 seconds. The signature clock check allows 5 seconds (the `signatureToleranceSeconds` option was removed in v0.4.0).

**Note:** a slow cold start can use up the 5 seconds. In local testing, a dev server that compiled for 4.5 s refused the first event with 401 `stale_timestamp`. Paddle sends the event again, so this costs one retry, not the event.

## Integration checklist

Do these steps one time for each app: first in sandbox, then again for live.

1. **Set the default payment link (dashboard only).**
   1. In the Paddle dashboard, open Paddle > Checkout > Checkout configuration.
   2. Set the *default payment link* to a public `https` URL of your app: the page that calls `createCheckout`. Paddle refuses `localhost`.
   3. **Do this in sandbox and in live.** They are different accounts. Without the link, checkout fails with `transaction_default_checkout_url_not_set`.
   4. Start Paddle.js when that page loads (for example, call `createCheckout` in an effect on mount, not only in a button click). Paddle opens a checkout link from the `_ptxn` query parameter when the page loads.

   We found no API for this setting (**UNVERIFIED** that there is none).
2. **Make the catalog.** Run `paddle-kit-catalog --webhook-url https://<host>/api/paddle` (see Catalog CLI). Read the table that it shows. Never copy the webhook secret by hand.
3. **Check the env.** Deploy with `readBillingEnv`. Make sure that `problems` is empty in the deployed environment, not only on your computer.
4. **Give CI and the host access to the private kit.**
   1. Make a fine-grained GitHub token with read access to the contents of `SnaxxTech/paddle-kit`.
   2. Save it as the repository secret `PADDLE_KIT_READ_TOKEN`.
   3. Before `npm ci`, rewrite all three GitHub URL forms that npm can use:
      ```bash
      for from in "ssh://git@github.com/" "git@github.com:" "https://github.com/"; do
        git config --global url."https://x-access-token:${PADDLE_KIT_READ_TOKEN}@github.com/".insteadOf "$from"
      done
      ```
   4. Give the secret to that step: `env: PADDLE_KIT_READ_TOKEN: ${{ secrets.PADDLE_KIT_READ_TOKEN }}`.
   5. **Make sure that the secret exists:** `gh api repos/<owner>/<repo>/actions/secrets --jq '.secrets[].name'` must show `PADDLE_KIT_READ_TOKEN`. A missing secret becomes an empty string, and the install fails with an unclear auth error.
   6. The host (for example Vercel) also needs access. How to do this depends on the host. **UNVERIFIED**: check the host's documents.
5. **A tunnel restart changes the URL.** A quick tunnel gets a new hostname each time it starts. Run the catalog CLI again with the new `--webhook-url`. It should move the existing destination and keep its secret. **UNVERIFIED**: after a restart, check that `PADDLE_NOTIFICATION_WEBHOOK_SECRET` in the env file still matches the destination.
6. **Do a test checkout.** In sandbox, pay with the test card `4242 4242 4242 4242`, any future expiry date and any CVC. Make sure that `subscription.*` and `transaction.completed` arrive, and that `hasAccess` changes.
7. **Do the wrong-secret drill.**
   1. Set `PADDLE_NOTIFICATION_WEBHOOK_SECRET` to a wrong value. Deploy.
   2. Send a simulator event. You must see HTTP 401 and `lastFailureReason: "signature_mismatch"` in health.
   3. Put back the real secret. **Deploy again** (an env change is a deploy).
   4. Make sure that the next real event is accepted.
8. **Go live.** Do steps 1–3, 6 and 7 again with live credentials:
   - Run the CLI with `--live` and a **separate env file** (`--env-file .env.production.local`, never the dev `.env.local`). Then a live key and a `test_` token cannot be in one file.
   - Use `PADDLE_ENV=production` and a `live_` client token.

## Known issues (still open in v0.4.0)

- **The past_due grace period can move.** The kit calculates the grace start from the stored row.
  - Two `past_due` events at the same time can make the grace longer, by the time between them.
  - A lost or late recovery event can join two `past_due` periods into one. Then the grace ends too early, and the customer loses access.
  - `reconcile` does **not** correct this, because it keeps the stored value.
  - Fix it by hand: `UPDATE paddle_subscriptions SET past_due_since = '<first past_due time>' WHERE subscription_id = '<sub_id>'`. Or wait until the subscription is no longer `past_due`.
- **Health does not count failures per reason.** `failedLast24h` is one total. Health shows only the last reason.

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

Test fixtures are the real payloads that we captured (see `tests/fixtures/SOURCES.md`).

**Not tested (UNVERIFIED):**

- A real renewal, and whether `current_billing_period` moves forward when a renewal fails. The simulator's demo subscription has a fixed period.
- A partial refund and a chargeback from real Paddle.
- Subscriptions that renew on archived prices.
- v0.4.0 with real sandbox events. The v0.4.0 tests used signed test events, not events from Paddle.
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
| `npm run smoke` | Packs the package, installs it in a temporary folder, imports each subpath and sends signed test events (`owns` filter, known and unknown refund). |
| `bash scripts/release.sh X.Y.Z` | Runs all checks, builds `dist/` into a release commit and tags it. Pushing the tag is a separate step. |

**CI is not on yet.** The workflow file is at `docs/ci-workflow.yml`. To turn it on, move it to `.github/workflows/ci.yml`. To push it, the GitHub token must have the `workflow` scope.

## Claude Code skill

`skills/integrating-paddle-kit/SKILL.md` tells an AI agent how to add the kit to an app: the decisions, the order of work, the sandbox test and the traps. Install it one time on each computer, and every project can use it:

```bash
ln -sfn ~/Desktop/Projects/paddle-kit/skills/integrating-paddle-kit ~/.claude/skills/integrating-paddle-kit
```

Then ask Claude Code to "add Paddle billing with paddle-kit" in any app. We tested the skill before we shipped it. Agents without it got 9–11 of 14 points on our integration checklist. With the skill, they got 13 of 14 (16 of 17 on the longer checklist).
