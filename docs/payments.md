# Checkout and payments

Reference moved out of the [README](../README.md). The security rules for checkout are in the README's [Security model](../README.md#security-model).

## Checkout created on the server, and the customer portal (`paddle-kit/server`, since v0.8.4)

Two server-only calls (they need `PADDLE_API_KEY`; never import `paddle-kit/server` in a client component):

- `createCheckoutTransaction(api, { userId, items, customerId?, customData?, allowedPriceIds? })` creates an
  automatically-collected transaction: when it is created, `custom_data.userId` is the `userId` you pass (from your session), and items
  are checked (whole quantities, and only `allowedPriceIds` when given) before Paddle is called. Returns
  `{ transactionId, checkoutUrl }`. The browser opens it with `checkout.openTransaction(transactionId, { email })` (the email prefills a first purchase, since v0.8.5).
  The browser can change both the items and the custom data of the open checkout afterwards (tested in the sandbox on
  2026-11-12, see the README's [Security model](../README.md#security-model)): grant by `tx.items` on the webhook.
- `customerPortalSession(api, { customerId, subscriptionIds? })` creates a portal session (one per click: the links
  are personal and expire) and returns `{ overview, subscriptions: { [id]: { cancel, updatePaymentMethod } } }`. Only
  links on `customer-portal.paddle.com` / `sandbox-customer-portal.paddle.com` are returned; anything else throws.

`api` is `{ apiKey, environment, fetch? }`; pass `billing.config.paddleFetch` (set by `billingFromEnv`) as `fetch`.
Errors are `PaddleError` with the HTTP `status` and Paddle's error code, never the key.

`app/billing/actions.ts`

```ts
'use server';
import { createCheckoutTransaction, customerPortalSession } from 'paddle-kit/server';
import { billing, config, products } from '@/lib/billing';
import { currentUser } from '@/lib/session'; // your auth: the signed-in user, from the session cookie

/** Returns a transaction id; the browser opens it with `checkout.openTransaction(id)`. */
export async function startCheckout(cycle: 'monthly' | 'yearly'): Promise<string> {
  const user = await currentUser();
  if (!user) throw new Error('sign in first');
  if (!billing || !config?.apiKey || !products) throw new Error('billing is not available');
  const api = { apiKey: config.apiKey, environment: config.environment, fetch: billing.config.paddleFetch };
  // The price comes from the product definition, never from the request: a retired price is never sold.
  const { transactionId } = await createCheckoutTransaction(api, {
    userId: user.id,
    items: [{ priceId: products.checkoutPriceId('pro', cycle), quantity: 1 }],
  });
  return transactionId;
}

/** The customer portal for the signed-in user's own billing: look the customer up in your records, never the request. */
export async function portalLink(): Promise<string> {
  const user = await currentUser();
  if (!user) throw new Error('sign in first');
  if (!billing || !config?.apiKey) throw new Error('billing is not available');
  const [subscription] = await billing.store.getSubscriptionsByUser(user.id);
  if (!subscription) throw new Error('no billing history yet');
  const api = { apiKey: config.apiKey, environment: config.environment, fetch: billing.config.paddleFetch };
  const portal = await customerPortalSession(api, { customerId: subscription.customerId, subscriptionIds: [subscription.subscriptionId] });
  return portal.overview; // redirect the browser here
}
```

Tested against the Paddle sandbox: the created transaction kept the server's `userId` when the extra `customData`
tried to set another one, and the portal links were all on `sandbox-customer-portal.paddle.com`. The block above runs
in `tests/server.test.ts`.

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
import { priceIdOf } from 'paddle-kit/config';
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
    return await paddlePrice(priceIdOf(config.prices, 'pro'), config.environment); // throws for a missing key
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

Show where the price came from in health with an app check (see [Monitoring](operations.md#monitoring), "App checks"):

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

## Fulfilment module (`paddle-kit/fulfil`, since v0.8.6)

The payment and refund rules of the examples below, kept by the kit: each payment's state and every adjustment in
kit tables (migration `005_fulfilment_outbox`, Postgres), one payment's changes at a time (an advisory lock), inside
your database transaction. You write only what a grant, a revoke and a restore mean for your users:

- a refund or chargeback that arrived **before** its payment: nothing is granted until it is reversed;
- a reversal gives back **what the revoke took** (`revoke` returns it), never more: spent credits stay spent;
- a partial refund, a chargeback warning, and a paid order `orderOf` does not fulfil become rows in
  `paddle_fulfilment_reviews` (a person decides), never only a log line;
- replays and late, older statuses change nothing; subscription payments are left to entitlements.

What the app can add (found by the first real consumer, Slop Remover's Full Scan):

- `orderOf(tx, q)` may be async and read the database (it runs inside the payment's lock), and `grant` may return
  `{ declined: reason }` (say, the order was already paid by another transaction): the payment is then `declined`,
  with a `declined:<reason>` review, and its later refunds change nothing.
- `revoke` and `restore` get `cause`, the adjustment behind them (refund or chargeback, for an audit row).
- `fulfilmentState(q, transactionId)` reads a payment: `held` / `granted` / `revoked` / `declined`, what it grants,
  what was taken, and `revokedBy` (`refund` / `chargeback`), e.g. for a checkout confirmation.
- `importFulfilment(q, { transactionId, userId, grants, state, revokedBy?, adjustmentId?, taken? })` brings in payments
  fulfilled before the kit, in a transaction. A revoked one needs the Paddle `adjustmentId` that took it back (since
  v0.8.7), approved in Paddle, and `taken` (what `restore` gives back): only that adjustment's own reversal gives the
  order back, a replay of it counts once, and an unrelated event changes nothing.
- `createFulfilment(db, actions, { onReview })` is called once for each new review (in the same transaction), so the
  app's own alerting sees them. A payment that arrived after its refund raises a `held_payment` review.

Side effects (a receipt email, a job) go to the **outbox** in the same transaction: `enqueue(q, { id, kind, payload })`
with `id` as the idempotency key, so they are sent only if the payment's changes commit, and once. `drainOutbox(query,
handlers)` sends due items at least once (retries 1 min, 2, 4, … 6 h). **Handlers must be idempotent on `item.id`**
(pass it as the idempotency key of the email or API call): a crash after sending, or a handler that runs past
`leaseSeconds`, sends the item again. Since v0.8.7 the drain claims one item at a time, counts each claim as an
attempt, and a worker whose lease was taken over cannot change the new run's retry state (`lost` in the result); a
finished send is always marked sent. Call it right after the payment commits (as the starters do), and
from an hourly route as the backstop, `createOutboxRoute({ cronSecret, drain })` (since v0.9.0; `drainOutbox`'s `budgetMs`,
default 20 s, stops new claims).

**Free-tier databases: no cron more often than hourly** (since v0.9.1). On Neon's free plan each project gets 100
CU-hours a month, a compute suspends 5 minutes after its last query, and a project over its allowance is suspended
until the next month. Each wake-up costs the work plus 5 idle minutes, so at 0.25 CU a cron every 5 minutes keeps it
awake all month (about 182 CU-hours: suspended around day 16), every 15 minutes about 61, hourly about 15, daily about
0. Webhooks already wake the database, so sending right after the payment costs nothing extra. `tests/starters.test.ts`
fails if a starter schedules a cron more often than once an hour. `outboxCheck(query)` turns health red for an item that gave up or waits over an hour.

`lib/credits.ts`

```ts
import { createFulfilment, enqueue, type FulfilmentActions, type SqlDb } from 'paddle-kit/fulfil';

// Your own table: CREATE TABLE accounts (user_id text PRIMARY KEY, credits int NOT NULL CHECK (credits >= 0));
declare const db: SqlDb; // your Postgres client with real transactions (pg, @neondatabase/serverless Pool, PGlite, ...)

export function creditPack(packPriceId: string, creditsPerUnit = 5) {
  const actions: FulfilmentActions<{ credits: number }> = {
    orderOf: (tx) => {
      const userId = tx.customData?.userId;
      const known = tx.items.length > 0 && tx.items.every((i) => i.priceId === packPriceId);
      if (typeof userId !== 'string' || !known) return null; // kept as a review row
      return { userId, grants: { credits: creditsPerUnit * tx.items.reduce((n, i) => n + i.quantity, 0) } };
    },
    async grant(q, f) {
      await q.query(
        'INSERT INTO accounts (user_id, credits) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET credits = accounts.credits + $2',
        [f.userId, f.grants.credits],
      );
      await enqueue(q, { id: `${f.transactionId}:receipt`, kind: 'receipt', payload: { userId: f.userId, credits: f.grants.credits } });
    },
    async revoke(q, f) {
      // Take back what is left of this pack; the balance is shared by the user's packs, so lock its row.
      const balance = (await q.query('SELECT credits FROM accounts WHERE user_id = $1 FOR UPDATE', [f.userId])).rows[0]?.credits ?? 0;
      const take = Math.min(balance, f.grants.credits);
      await q.query('UPDATE accounts SET credits = credits - $1 WHERE user_id = $2', [take, f.userId]);
      return take;
    },
    async restore(q, f) {
      await q.query('UPDATE accounts SET credits = credits + $1 WHERE user_id = $2', [Number(f.taken), f.userId]);
    },
  };
  return createFulfilment(db, actions);
}
```

Spread `creditPack(packPriceId)` into the `billingFromEnv` options. It needs the pack's price id when it is built: read
it with `readBillingEnv` first (`priceIdOf(config.prices, 'pack')`). Add `readiness: { fulfilment: true, … }` so health
checks migration 005, and drain the outbox from the recovery cron:

```ts
export const { GET } = createRecoveryRoute({
  billing, problems, apiKey: config?.apiKey, cronSecret: process.env.CRON_SECRET,
  drainOutbox: () => drainOutbox((text, params) => pool.query(text, params), { receipt: (p) => sendReceiptEmail(p) }),
});
```

Tested: `tests/fulfil.test.ts` runs every scenario of the hand-written examples through the module on PGlite, and
`tests/readme-presets.test.ts` runs `lib/credits.ts` above as written; on a real Postgres 17
(`tests/pg-concurrency.test.ts`) a payment, its refund, chargeback and won dispute racing on separate connections end
at 0 credits in 20 of 20 rounds, and four outbox drains racing send each of 40 items exactly once.

## One-time purchases and refunds (hooks)

**Use a starter first** (`examples/unlock`, `examples/credits`): they run `paddle-kit/fulfil`, which keeps each
payment's refund and chargeback state for you. The hand-written hooks and examples below are the lower-level way,
for an app with needs the module does not cover.

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

   **Keep every adjustment against its transaction, `known: false` ones too. Never drop it.** Then your payment code checks it: a payment whose refund arrived first grants nothing (the Example's `adjustments` table and `settle`).
9. **Derive what a payment grants from all its adjustments, never by counting events (v0.8.0).** Refunds and chargebacks overlap: a won chargeback must not give back credits while a separate full refund still stands. `paymentRevoked(adjustments)` says whether the payment stands taken back. Run one payment's changes one at a time (the Example locks per transaction).
4. **`custom_data` comes from the browser, so do not trust it.** Check the order with `tx.items` (`priceId`, `quantity`). The catalog price sets the amount.
5. **Do not compare amounts or currency with your list price.** Paddle can show a local price (EUR for a USD list price). Discounts and tax also change the amounts. Record `tx.currency`, `tx.subtotal` (before discount and tax) and `tx.total` (with tax). Amounts are strings in the lowest unit (cents).
6. **Give the item in one database transaction.** Insert the order and give the credits together. If you insert the order first and the grant then fails, the retry sees "already done", and the customer paid for nothing.
7. **Take back credits automatically only on an approved full refund.** `adj.type` is `'full'`, `'partial'` or `null`. A partial refund does not say which credits to take back, so put it in a review queue for a person. Never let a balance go below zero.
8. **Never drop a paid order without a record.** For an unknown price id or a missing user id, write a `reviews` row (a person then refunds or fulfils by hand). Do not only write a log line. Grant by quantity. Do not refuse `quantity !== 1`.

### Example

A credit pack, refunds and chargebacks included. The tables (Postgres):

```sql
-- granted: what the payment gave. revoked: a refund or chargeback that still stands took it back. taken: how many credits
-- that revoke actually removed (credits already spent are gone), so a reversal gives back exactly that many.
CREATE TABLE orders (id text PRIMARY KEY, user_id text NOT NULL, credits int NOT NULL, granted int NOT NULL DEFAULT 0,
  revoked boolean NOT NULL DEFAULT false, taken int NOT NULL DEFAULT 0, currency text, total text);
-- Every adjustment, kept against its transaction even before the payment arrives (a refund can come first).
CREATE TABLE adjustments (id text PRIMARY KEY, transaction_id text NOT NULL, action text NOT NULL, type text,
  status text NOT NULL, rank int NOT NULL);
CREATE INDEX adjustments_transaction_id_idx ON adjustments (transaction_id);
CREATE TABLE reviews (id text PRIMARY KEY, kind text NOT NULL, detail text);
CREATE TABLE accounts (user_id text PRIMARY KEY, credits int NOT NULL CHECK (credits >= 0));
```

```ts
import { adjustmentEffect, paymentRevoked, type BillingConfig } from 'paddle-kit/core';

type Tx = { query(text: string, params?: unknown[]): Promise<{ rows: any[] }> };
declare const db: { transaction<T>(fn: (q: Tx) => Promise<T>): Promise<T> };

// `db` is your Postgres client with real transactions (pg, @neondatabase/serverless Pool, PGlite, ...).
const review = (q: Tx, id: string, kind: string, detail: string) =>
  q.query('INSERT INTO reviews (id, kind, detail) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, kind, detail]);

// One payment's changes run one at a time: its payment and adjustments can arrive in any order, and at the same moment.
const lockPayment = (q: Tx, transactionId: string) => q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [transactionId]);

// Brings the order in line with its adjustments: grant it, take it back, or give back what was taken. Derived from all
// the adjustments, never counted event by event, so replays, reorderings and overlapping refunds and chargebacks all
// end in the same balance.
async function settle(q: Tx, transactionId: string) {
  const order = (await q.query('SELECT user_id, credits, granted, revoked, taken FROM orders WHERE id = $1', [transactionId])).rows[0];
  if (!order) return; // not paid yet: the payment settles when it arrives
  const adjustments = (await q.query('SELECT action, type, status FROM adjustments WHERE transaction_id = $1', [transactionId])).rows;
  const revoked = paymentRevoked(adjustments);
  await q.query('INSERT INTO accounts (user_id, credits) VALUES ($1, 0) ON CONFLICT DO NOTHING', [order.user_id]);
  // The balance is shared by the user's orders, which settle under different payment locks: lock the row.
  const balance = (await q.query('SELECT credits FROM accounts WHERE user_id = $1 FOR UPDATE', [order.user_id])).rows[0].credits;
  if (revoked && !order.revoked) {
    // Take back what is left of this order's credits; spent credits are gone (a person decides, e.g. from `reviews`).
    const take = Math.min(balance, order.granted);
    await q.query('UPDATE accounts SET credits = credits - $1 WHERE user_id = $2', [take, order.user_id]);
    await q.query('UPDATE orders SET revoked = true, taken = $1 WHERE id = $2', [take, transactionId]);
  } else if (!revoked && (order.revoked || order.granted === 0)) {
    // The first grant, or a give-back of exactly what the revoke took (all of it if the payment was never granted).
    const give = order.granted === 0 ? order.credits : order.taken;
    await q.query('UPDATE accounts SET credits = credits + $1 WHERE user_id = $2', [give, order.user_id]);
    await q.query('UPDATE orders SET granted = credits, revoked = false, taken = 0 WHERE id = $1', [transactionId]);
  }
}

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
        await lockPayment(q, tx.transactionId);
        const credits = creditsPerUnit * tx.items.reduce((n, i) => n + i.quantity, 0); // grant by quantity
        // The currency is recorded, not required: Paddle can localise the price (EUR for a USD list price).
        const ins = await q.query(
          'INSERT INTO orders (id, user_id, credits, currency, total) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id',
          [tx.transactionId, userId, credits, tx.currency, tx.total],
        );
        if (ins.rows.length === 0) return; // replay of a transaction already recorded
        await settle(q, tx.transactionId); // a refund that arrived first is already in `adjustments`: then nothing is granted
      });
    },
    onAdjustment: async (adj) => {
      // revoke (approved full refund, chargeback) · restore (chargeback won, refund or chargeback reversed)
      // review (partial refund, chargeback warning, unknown action) · none (pending, rejected, credits)
      const effect = adjustmentEffect(adj);
      await db.transaction(async (q) => {
        await lockPayment(q, adj.transactionId);
        // Kept whatever the effect, even for a payment not seen yet (`ctx.known === false`). A status only moves
        // forward (pending_approval → approved / rejected → reversed), so a late, older delivery changes nothing.
        await q.query(
          `INSERT INTO adjustments (id, transaction_id, action, type, status, rank)
           VALUES ($1, $2, $3, $4, $5, CASE $5 WHEN 'pending_approval' THEN 0 WHEN 'reversed' THEN 2 ELSE 1 END)
           ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, rank = EXCLUDED.rank WHERE adjustments.rank < EXCLUDED.rank`,
          [adj.adjustmentId, adj.transactionId, adj.action, adj.type, adj.status],
        );
        // A partial refund does not say which credits to take back; a warning may still turn into a refund: a human decides.
        if (effect === 'review') await review(q, `adj:${adj.adjustmentId}:${adj.status}`, adj.action, `${adj.currency} ${adj.total}`);
        await settle(q, adj.transactionId);
      });
    },
  };
}
```

Connect it with the price id from `readBillingEnv`. Do not use `JSON.parse(process.env.PADDLE_PRICES)` at module scope.

```ts
export const billing = config
  ? createBilling({ /* environment, webhookSecret, store, entitlements */ ...packHooks(priceIdOf(config.prices, 'pack')) })
  : null;
```

We ran this example against a real SQL database (PGlite), through the built package. Results:

- A database failure in the grant also removed the order. Paddle's retry then gave the credits one time.
- An unknown price made a review row.
- A EUR order with quantity 2 gave 10 credits.
- Two partial refunds did not change the balance.
- An approved full refund took the credits back one time, and never below zero.

The example itself is a test (`tests/readme-hooks.test.ts`, on PGlite): the test reads the SQL and TypeScript blocks above out of this file and runs them as written. Since v0.8.0 it also covers the two cases the v0.7 example got wrong: a full refund that arrived **before** its payment (the payment now grants nothing), and a won chargeback while a separate full refund still stands (nothing is given back). A chargeback took the credits and a won dispute gave them back one time; a refund that was approved and then reversed took them and gave them back; a give-back with nothing taken back gave nothing; redeliveries and older, late statuses changed nothing; a partial refund and a chargeback warning became review rows. Since v0.8.1 a reversal gives back only what the revoke took: buy 5, spend 3, refund (takes the 2 left), reverse: 2 come back, not 5. Not yet seen from real Paddle: a chargeback, its reversal, or a reversed refund.

### Example: a one-time unlock

A price that unlocks a feature for good (a lifetime licence, a template pack). A full refund or a chargeback that still
stands takes it away; a reversal gives it back. The tables (Postgres):

```sql
CREATE TABLE unlocks (transaction_id text NOT NULL, user_id text NOT NULL, feature text NOT NULL,
  revoked boolean NOT NULL DEFAULT false, PRIMARY KEY (transaction_id, feature));
CREATE INDEX unlocks_user_idx ON unlocks (user_id, feature);
-- Every adjustment, kept against its transaction even before the payment arrives (a refund can come first).
CREATE TABLE unlock_adjustments (id text PRIMARY KEY, transaction_id text NOT NULL, action text NOT NULL, type text,
  status text NOT NULL, rank int NOT NULL);
-- Paid, but not unlocked automatically (no user, or a price that unlocks nothing): a person refunds or unlocks by hand.
CREATE TABLE unlock_reviews (transaction_id text PRIMARY KEY, reason text NOT NULL, detail text,
  created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz);
```

```ts
import { paymentRevoked, type BillingConfig } from 'paddle-kit/core';

type Tx = { query(text: string, params?: unknown[]): Promise<{ rows: any[] }> };
declare const db: { transaction<T>(fn: (q: Tx) => Promise<T>): Promise<T>; query: Tx['query'] };

const lockPayment = (q: Tx, transactionId: string) => q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [transactionId]);

// The unlocks of a payment stand unless an adjustment that still stands took the payment back.
async function settle(q: Tx, transactionId: string) {
  const adjustments = (await q.query('SELECT action, type, status FROM unlock_adjustments WHERE transaction_id = $1', [transactionId])).rows;
  await q.query('UPDATE unlocks SET revoked = $1 WHERE transaction_id = $2', [paymentRevoked(adjustments), transactionId]);
}

/**
 * `features`: price id -> the feature it unlocks, or a function returning that map (read when a payment arrives, so
 * it can use the config `billingFromEnv` returns): `() => ({ [priceIdOf(config!.prices, 'lifetime')]: 'pro' })`.
 */
export function unlockHooks(features: Record<string, string> | (() => Record<string, string>)): Pick<BillingConfig, 'onTransaction' | 'onAdjustment'> {
  return {
    onTransaction: async (tx) => {
      if (tx.subscriptionId !== null) return; // a subscription payment: entitlements handle it
      const map = typeof features === 'function' ? features() : features;
      const userId = tx.customData?.userId; // untrusted, but a user can only pay for someone else
      const unlocked = tx.items.map((i) => map[i.priceId]).filter((f): f is string => !!f);
      await db.transaction(async (q) => {
        if (typeof userId !== 'string' || unlocked.length === 0) {
          // Paid, but nothing to unlock automatically. Keep it (never just log), keyed by the payment, so a replay
          // adds nothing and the payment stays visible until a person refunds it or unlocks by hand.
          const reason = typeof userId !== 'string' ? 'no_user' : 'unknown_price';
          await q.query('INSERT INTO unlock_reviews (transaction_id, reason, detail) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [tx.transactionId, reason, `${tx.currency} ${tx.total}: ${tx.items.map((i) => i.priceId).join(', ')}`]);
          return;
        }
        await lockPayment(q, tx.transactionId);
        for (const feature of unlocked) {
          await q.query('INSERT INTO unlocks (transaction_id, user_id, feature) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [tx.transactionId, userId, feature]);
        }
        await settle(q, tx.transactionId); // a refund that arrived first keeps it revoked
      });
    },
    onAdjustment: async (adj) => {
      await db.transaction(async (q) => {
        await lockPayment(q, adj.transactionId);
        // A status only moves forward (pending_approval → approved / rejected → reversed).
        await q.query(
          `INSERT INTO unlock_adjustments (id, transaction_id, action, type, status, rank)
           VALUES ($1, $2, $3, $4, $5, CASE $5 WHEN 'pending_approval' THEN 0 WHEN 'reversed' THEN 2 ELSE 1 END)
           ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, rank = EXCLUDED.rank WHERE unlock_adjustments.rank < EXCLUDED.rank`,
          [adj.adjustmentId, adj.transactionId, adj.action, adj.type, adj.status],
        );
        await settle(q, adj.transactionId);
      });
    },
  };
}

/** For `canUse` in lib/policy.ts: a subscription (`billing.hasAccess`) or an unlock that still stands. */
export async function hasUnlock(userId: string, feature: string): Promise<boolean> {
  const rows = (await db.query('SELECT 1 FROM unlocks WHERE user_id = $1 AND feature = $2 AND NOT revoked LIMIT 1', [userId, feature])).rows;
  return rows.length > 0;
}
```

Wire it in `lib/billing.ts` (the Quickstart's, with a `lifetime` price) and let `canUse` ask both:

```ts
// lib/billing.ts: the Quickstart's call, plus the hooks
export const { billing, config, problems, enforce } = billingFromEnv(process.env, {
  requiredPrices: ['lifetime'],
  store: postgresStore({ query: (text, params) => pool.query(text, params) }),
  ...unlockHooks(() => ({ [priceIdOf(config!.prices, 'lifetime')]: 'pro' })),
  readiness: { cronSecret: process.env.CRON_SECRET },
});
```

`lib/policy.ts` with unlocks

```ts
import { billing, enforce } from '@/lib/billing';
import { hasUnlock } from '@/lib/unlocks';

export async function canUse(userId: string | null, feature: string): Promise<boolean> {
  if (!userId) return false;
  if (!billing) return !enforce;
  return (await billing.hasAccess(userId, feature)) || hasUnlock(userId, feature);
}
```

This example is a test too (`tests/readme-presets.test.ts`, on PGlite). Through a signed `transaction.completed` and
`canUse`: a payment unlocked the feature, a replay did not duplicate it, a full refund took it away and its reversal
gave it back. A refund that arrived first kept it locked; a partial refund changed nothing. A payment with no user or
an unknown price unlocked nothing and stayed in `unlock_reviews`, once per payment.

### Refunds, chargebacks and reversals (`adjustmentEffect`, since v0.7.0)

Every change to a payment arrives as an adjustment, and the same adjustment comes again when its status moves (`pending_approval` → `approved` / `rejected` → maybe `reversed`). `adjustmentEffect(adj)` turns Paddle's actions and statuses into what the app should do:

| Action (status `approved`) | Effect | Why |
|---|---|---|
| `refund`, `type: 'full'` | `revoke` | The customer got all the money back. |
| `refund`, `type: 'partial'` (or unknown) | `review` | It does not say which items were refunded. |
| `chargeback` | `revoke` | The card holder disputed the charge; the money is gone. Paddle, as merchant of record, fights the dispute. |
| `chargeback_reverse` | `restore` | The dispute was won; the money is back. |
| `chargeback_warning` | `review` | An early fraud warning. Paddle may refund it to avoid the chargeback; watch the transaction. |
| `chargeback_warning_reverse`, `credit`, `credit_reverse` | `none` | No money left the seller for this purchase. |
| any action with status `reversed` (refund, chargeback) | `restore` | The adjustment was undone. |
| any action `pending_approval` or `rejected` | `none` | Nothing happened yet, or never will. |
| an action or status Paddle adds later | `review` | Never guessed. |

Source: Paddle, [List adjustments](https://developer.paddle.com/api-reference/adjustments/list-adjustments), read 2026-10-30. Refunds are made in the Paddle dashboard (or with Paddle's API); the kit only receives them.

## Patterns for the app's own code

**Outbox for side effects.** A hook runs inside the webhook request, and a failure anywhere makes Paddle send the event again. So a hook should only write to your database, in one transaction: the order, the grant, and a row in an `outbox` table for each side effect (an email, starting a job). A worker (a cron, a queue) sends what is in the outbox and marks it sent. Then a slow or failed email never fails the payment, and a retried event never sends the email twice (key the outbox row on `transactionId` + kind, `ON CONFLICT DO NOTHING`).

**A ledger for credits.** An app that sells credits (packs, scans) should keep an append-only ledger in its own database instead of only a balance: one row per change (`grant` keyed on `transactionId`, `use` on your usage id, `revoke` / `restore` keyed on `adjustmentId:status`), the balance being the sum. Each Paddle event then maps to at most one row (the key makes it idempotent), and a support question ("where did my credits go?") is a query. Paddle keeps the books of the money as merchant of record; the app keeps the books of what it granted.

## Payment concepts: what the kit does, and what Paddle does

Paddle is the **merchant of record**: it charges the card, holds the money, handles disputes and pays out. The kit receives Paddle's events safely and tells the app what they mean.

| Concept | Where it lives |
|---|---|
| Webhook retries and dedup | The kit: `paddle_events` ledger keyed on `event_id`, claims (409 `in_progress`), a 60 s lease for a crashed attempt, `occurred_at` ordering. Paddle retries any non-2xx (live: up to 60 times in about two days). |
| Idempotency keys | The kit for events (`event_id`); the app for its writes (key them on `transactionId`, `adjustmentId` + `status`). |
| Exactly-once vs effectively-once | Effectively-once: hooks run at least once; claims stop concurrent copies; the app's keyed write in one DB transaction makes the effect happen once. |
| Refunds, chargebacks, reversals | Received through `onAdjustment`; `adjustmentEffect` says revoke / restore / review / none. Issued in the Paddle dashboard. |
| Reconciliation | `reconcile` (subscriptions) and `reconcilePayments` (transactions and adjustments) replay the API through the webhook path. |
| Authorisation vs capture | Paddle: checkout authorises and captures together. The kit grants on `transaction.completed` only (`transaction.paid` is recorded, no hook). |
| Pending states | Refunds `pending_approval` → `none`; `past_due` keeps access for `pastDueGraceDays`; trials in `planOf`. The money itself is held by Paddle. |
| Settlement cycles | Paddle pays out on its schedule; see Paddle's payout reports. `payout.*` events are recorded and ignored. |
| Double-entry ledger | Paddle keeps the books of the money. The app keeps an append-only ledger of what it granted (above). |
| Outbox | The app's code (above): side effects go through an outbox written in the hook's transaction. |

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
