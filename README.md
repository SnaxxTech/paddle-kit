# paddle-kit

paddle-kit is a TypeScript library for web apps that sell with Paddle Billing (v2, not Paddle Classic). It verifies
Paddle's webhooks, records each event one time in your own Postgres or SQLite database, and keeps a copy of each
subscription there, so the app can answer "did this user pay?" without a call to Paddle. It also handles refunds and
chargebacks, repairs missed webhooks with an hourly job, and has two CLIs: one makes the Paddle catalog, one checks a
deployed app.

## Status

- Version 0.9.3.
- Tested with real checkouts and refunds in the Paddle sandbox, and with the test suite: in-process tests, plus real
  Postgres (16 in CI, 17 on our computers) and real workerd (the Cloudflare Workers runtime).
- **Not yet used with live money.**
- Not tested yet: a real renewal, a partial refund and a chargeback from real Paddle.

Details: [What we tested, and what we did not](docs/limits-and-tests.md#what-we-tested-and-what-we-did-not).

## What problems it solves

| Problem | What goes wrong without the kit | What the kit does | Proof (test) |
|---|---|---|---|
| Forged or replayed webhooks | Anyone can POST a fake "paid" event. | An HMAC check on the raw body, a timestamp check (at most 5 seconds old, at most 60 seconds ahead) and a body size cap. An unverified request never touches the database. | `tests/signature.test.ts`, `tests/handler.test.ts` |
| The same event arrives twice, or twice at the same moment | The user is granted or charged back twice. | An event ledger keyed on `event_id`, plus a claim: parallel copies run the hooks once, and a copy of an event that was already processed runs nothing. A failed or timed-out delivery is retried and runs the hooks again, so hooks must be idempotent. | `tests/pg-concurrency.test.ts`: "N=50 parallel deliveries of one event: each hook runs once, one ledger row" |
| Events arrive out of order | An old "active" overwrites a newer "canceled". | The subscription mirror accepts a snapshot only when its `occurred_at` is not older. | `tests/pg-concurrency.test.ts`: "parallel subscription.updated events in shuffled order converge on the newest state (5 rounds)" |
| "Did this user pay?" on every request | A Paddle API call per page view, or stale flags. | `billing.hasAccess(userId, feature)` reads your own database. `past_due` keeps access for a grace period. | `tests/access.test.ts`, `tests/billing.test.ts` |
| Refund, chargeback and reversal in any order | Credits are taken back twice, or a won dispute never restores them. | `paddle-kit/fulfil` keeps one state per payment (held, granted, revoked, declined). A partial refund becomes a review row for a person. | `tests/fulfil.test.ts`; `tests/pg-concurrency.test.ts`: "fulfil: a payment, its refund, chargeback and won dispute racing on separate connections end at 0 credits (20 rounds)" |
| A webhook is lost (outage, retries used up) | A paid user has no access until someone notices. | An hourly recovery job reads Paddle's API again and replays what was missed through the same path as a webhook. | `tests/recovery.test.ts`, `tests/recovery-paging.test.ts`, `tests/reconcile.test.ts` |
| Several apps share one Paddle account | Every app receives every app's events. | `owns` keeps only this app's prices. Other events are acknowledged and ignored, with two exceptions: a refund for a transaction the app has never seen still reaches `onAdjustment` with `known: false`, and a subscription already in the mirror stays yours. | `tests/shared-seller.test.ts`, `tests/ownership.test.ts` |
| A broken or missing env variable | The build crashes, or every paid feature becomes free. | `billingFromEnv` names the bad variable, never its value. With enforcement on, a broken config refuses paid features. | `tests/config.test.ts`, `tests/readiness.test.ts` |
| Nobody notices that billing is broken | Failed events pile up silently. | An authenticated health route, and `paddle-kit-doctor`. | `tests/doctor.test.ts` |
| Emails and other side effects | A retried webhook sends the receipt twice, or a failed send loses it. | An outbox, written in the payment's database transaction, so a retried webhook adds no second item and a failed send is retried. Sending is at least once (a crash after a send sends it again): make the sender idempotent on `item.id`. | `tests/pg-concurrency.test.ts`: "outbox: four drains racing on separate connections send each of 40 items exactly once" |

## How it compares

Paddle's docs list what a correct integration needs: deduplicate on `event_id`, order by `occurred_at`, answer within
5 seconds, and run a periodic reconciliation job if you keep a copy of the state. With Paddle's Node SDK alone, you write
and test those parts yourself. The kit is those parts, already written and tested.

| | Paddle's Node SDK and your own handler | paddle-kit |
|---|---|---|
| Signature check | Yes, with a 5-second tolerance. | Yes: at most 5 seconds old, at most 60 seconds ahead, and a body size cap. |
| Typed API client | Yes. | No. The kit calls the few endpoints it needs with `fetch`. |
| Deduplication on `event_id` | You write it. | An event ledger, plus a claim for parallel deliveries. |
| Ordering by `occurred_at` | You write it. | The subscription mirror ignores an older snapshot. |
| Access check | You write it. | `billing.hasAccess(userId, feature)`, read from your database. |
| Refunds and chargebacks | You write it. | `adjustmentEffect`, and `paddle-kit/fulfil` with one state per payment. |
| Missed-webhook repair | You write a reconciliation job. | An hourly recovery job through the webhook path. |
| Shared seller account filter | You write it. | `owns`. |
| Health and alerts | You write it. | A health route and `paddle-kit-doctor`. |
| Runtime dependencies | The SDK. | None. The browser checkout needs the optional `@paddle/paddle-js` peer. |

### What it costs you

- On Postgres, the six migrations create 14 `paddle_*` tables in your database (12 are in use: 8 for the core, 4 for fulfilment and the outbox). On SQLite, five migrations create 10 tables.
- Events are processed inside the webhook request (several database round trips), not on a queue.
- Fulfilment and the outbox work on Postgres only.
- The event tables are never pruned.
- It is young, and it has not handled live money.

### When not to use it

- In-app purchases in mobile store apps (Google Play, the App Store).
- An app with no Postgres or SQLite database.
- You already run a queue-based billing service.

## Quickstart: the standard setup (since v0.8.0)

This is the one supported setup; start here. Every app uses the same four pieces. Nothing else is needed: no billing
service, no queue, no Redis. The reference is in `docs/` (see [Documentation](#documentation)). Notes for older versions are in
[docs/HISTORY.md](docs/HISTORY.md) and [CHANGELOG.md](CHANGELOG.md).

**One set of billing tables per app and per environment.** The `paddle_*` tables carry no app or environment column:
two apps, or an app's sandbox and live deployments, sharing one database (and schema) would read each other's events,
subscriptions and recovery checkpoint. Give each its own database, Neon branch or Postgres schema.

1. **One config** (`lib/billing.ts`): `billingFromEnv`.
2. **One webhook route** (`app/api/paddle/route.ts`): `createWebhookRoute`.
3. **One scheduled recovery job** (`app/api/cron/billing-recovery/route.ts`): `recoverBilling`.
4. **One app policy module** (`lib/policy.ts`): the only place that decides what a user may do.

Run migrations `001`–`006` ([Run the migrations](docs/setup.md#run-the-migrations)) before the first deploy of this version (`005` is used only by `paddle-kit/fulfil`; it is harmless and empty otherwise).

**Start from a starter (since v0.9.0).** Copy the folder for what you sell into the app. Each one is complete, and
`tests/starters.test.ts` runs every file of it as written, on real Postgres, with signed webhooks into its routes.

| You sell | Starter | What it adds to the four pieces |
|---|---|---|
| A subscription | [`examples/subscription`](examples/subscription) | `products` maps the plan's prices to features; `canUse` checks them. |
| A one-time unlock (lifetime licence) | [`examples/unlock`](examples/unlock) | `paddle-kit/fulfil` with a `user_unlocks` table; a second payment for an unlock becomes a review. |
| Credit packs | [`examples/credits`](examples/credits) | `paddle-kit/fulfil` with a `credit_accounts` table; a refund takes back only the credits that are left. |

The unlock and credits starters also send the receipt queued with each payment **right after the payment commits**
(`lib/outbox.ts`, called from `onTransaction`, bounded to 5 items and 2 s), and have a **fifth piece**: an hourly
outbox route (`app/api/cron/outbox/route.ts`) as the backstop for a send that failed. Health covers all of it by default:
the API key, the migrations, `CRON_SECRET`, outbox items that wait or gave up (`outboxCheck`), and fulfilment reviews
that need a person (`reviewsCheck`; `resolveReview(q, id)` clears one). Each starter's `lib/db.ts` uses postgres-js
through `paddle-kit/db`; for pg, the Neon Pool or PGlite, change that one line (see [Postgres clients](docs/setup.md#postgres-clients)). The blocks
below are the subscription setup, as in `examples/subscription`.

`lib/billing.ts`

```ts
import { Pool } from '@neondatabase/serverless';
import { billingFromEnv } from 'paddle-kit/config';
import { postgresStore } from 'paddle-kit/postgres';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const { billing, config, problems, enforce, products } = billingFromEnv(process.env, {
  store: postgresStore({ query: (text, params) => pool.query(text, params) }),
  // One definition for access and checkout (since v0.8.3). Each key is a PADDLE_PRICES key ("pri_…" or a cycle map);
  // its prices on sale grant `features`. When you replace a price, move the old id to `retiredPriceIds`: subscriptions
  // on it keep their features (and its events stay yours) while checkout sells only the new one.
  products: { pro: { features: ['pro'], retiredPriceIds: [] } },
  onError: (error, ctx) => console.error('paddle-kit failure', ctx, error), // may hold secrets: your error tracker only
  // Health shows whether the API key has the permissions recovery needs, migrations 003/004 are in, and CRON_SECRET is
  // set (since v0.8.2). Add `permissions: ['subscription.write']` if the app changes plans through the API.
  readiness: { cronSecret: process.env.CRON_SECRET },
});
if (problems.length > 0) console.error('billing misconfigured:', problems.join('; ')); // names only, never values
```

Checkout opens with a price on sale, never a retired one: `products!.checkoutPriceId('pro', 'monthly')`.

What `billingFromEnv` now does by default:

- **Resilient Paddle calls.** One `createPaddleTransport()` per app and environment (returned as `transport`, and set as `billing.config.paddleFetch`). Price lookups, `reconcile`, `reconcilePayments` and `recoverBilling` use it unless a call passes its own `fetch`: bounded GET retries with backoff and jitter, `Retry-After`, a circuit breaker, no automatic retry of a mutation.
- **Explicit, historical ownership.** With `PADDLE_PRICES` set (subscription apps: `entitlements` needs the ids when billing is built), `owns` is every id in it. With `resolvePrices: { app }` and no `PADDLE_PRICES` (one-time sales), `owns` is read from the store's owned ids: every price and product of the app, archived ones included, so a late payment or renewal on a retired price is still yours. The webhook path never asks Paddle. Until the recovery job has filled the ids once, events answer **503** `prices_unavailable` (Paddle retries); they are never acked as `not_ours`. On a shared seller account never leave `owns` unset: unset means "every event is mine".
- **`enforce`** is on with `BILLING_ENFORCE=1`, off with `BILLING_ENFORCE=0`, and otherwise on when `PADDLE_ENV=production` (since v0.9.2). It is read even when the rest of the env is broken.

`app/api/paddle/route.ts`

```ts
import { createWebhookRoute } from 'paddle-kit/next';
import { billing, problems } from '@/lib/billing';

export const { POST, GET } = createWebhookRoute({ billing, problems, healthToken: process.env.PADDLE_HEALTH_TOKEN });
```

`app/api/cron/billing-recovery/route.ts`

```ts
import { createRecoveryRoute } from 'paddle-kit/reconcile';
import { billing, config, problems } from '@/lib/billing';

export const maxDuration = 60; // the job's own budget is 45 s

// Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. With CRON_SECRET unset every call is refused (401).
// A misconfigured app (env problems, or no PADDLE_API_KEY) answers 500 with the problem names, so the cron log shows
// it; only billing deliberately off (no billing variable at all) answers 200 `off`. A failed run answers 500 too.
export const { GET } = createRecoveryRoute({ billing, problems, apiKey: config?.apiKey, cronSecret: process.env.CRON_SECRET });
```

`vercel.json`: `{ "crons": [{ "path": "/api/cron/billing-recovery", "schedule": "0 * * * *" }] }`. Hourly on Vercel Pro; the Hobby plan allows one run a day, which is still enough (the doctor flags a job with no success for 26 h). The job:

1. keeps the owned price and product ids (`syncOwnership`, with `resolvePrices`);
2. replays unfinished webhook events by their original ids;
3. repairs subscriptions and payments through the same hooks and claims as webhooks;
4. moves its checkpoint only when every step succeeded. A record it cannot judge (for example an adjustment without a valid date) makes the run `failed` / `incomplete`, with the counts in the result, and keeps the checkpoint.

The health route reports the job under `recovery`: latest status and reason, `lastSucceededAt`, `checkpointAt` and `checkpointAgeSeconds`, next to the unresolved work (`unresolvedFailed`, `oldestPendingAt`). `paddle-kit-doctor` turns red when the job never completed or has not completed for 26 h.

`lib/policy.ts`

```ts
import { billing, enforce } from '@/lib/billing';

/** The only place that decides whether `userId` may use `feature`. Reads the app's own database: no Paddle call. */
export async function canUse(userId: string | null, feature: string): Promise<boolean> {
  if (!userId) return false;
  // Billing not set up and not enforced (before launch): the free experience. Broken config with enforcement on: refuse.
  if (!billing) return !enforce;
  return billing.hasAccess(userId, feature);
}
```

Rules for every app:

- **Create the checkout on the server, and still decide on the webhook.** `createCheckoutTransaction` checks the items and sets `custom_data.userId` from your session before Paddle is called. It does not lock the checkout: Paddle.js can change the items and the custom data of an open checkout from the browser (tested in the sandbox on 2026-11-12, see [Security model](#security-model)). Grant by `tx.items` in the hook, and treat `custom_data` as untrusted.
- **Broken config never unlocks paid operations when enforcement is on** (`canUse` above), and since v0.9.2 enforcement is on by default when `PADDLE_ENV=production` (`BILLING_ENFORCE=0` opts out). Show the problem names only on the authenticated health route.
- **Archive retired prices in Paddle.** Paddle.js can open a checkout for any active price, whatever your server allows; the `retired_prices` health check (v0.9.2) is red while a retired price is still active.
- **A full refund or a chargeback of a subscription payment does not cancel it in Paddle.** The subscription starter cancels it at once (`cancelSubscription`, v0.9.2). If you do the same, cancel **only your own** subscription: return unless `ctx.known` and your mirror has it (v0.9.3), because on a shared seller account you receive every app's adjustments.
- **Separate sandbox and live keys.** `PADDLE_ENV=sandbox` with `test_` / `pdl_sdbx_` credentials (Vercel Preview and Development), `PADDLE_ENV=production` with `live_` / `pdl_live_` (Vercel Production only). `readBillingEnv` refuses a mix, and `recoverBilling` refuses an API key of the other environment.
- **Business effects deduplicate by Paddle's ids, not by event ids.** A recovery replay of a payment or refund carries a new event id (`reconcile_txn_…`, `reconcile_adj_…`), so grant on `transactionId` and keep adjustments by `adjustmentId` (see [One-time purchases and refunds](docs/payments.md#one-time-purchases-and-refunds-hooks)).

## Security model

- **Trusted:** the webhook signature, and the ids, line items (price ids, quantities) and amounts inside a verified event.
- **Never trusted:** `custom_data`, and anything else the browser can set.
- **Tested in the Paddle sandbox on 2026-11-12:** a transaction created on the server (status `draft`, and again
  `ready` with a customer) and opened with `Paddle.Checkout.open({ transactionId })` was changed from the browser with
  `Paddle.Checkout.updateCheckout()`. `custom_data` was replaced, including `userId`. The items were replaced too, also
  with a price of another app on the same seller account. Paddle's API then returned the changed transaction. Record:
  [docs/audits/2026-11-12-checkout-edit-probe.md](docs/audits/2026-11-12-checkout-edit-probe.md).

So:

- Grant by the line items of the completed transaction.
- Treat `custom_data.userId` as "who the buyer says gets it". The most a buyer can do with it is pay for someone else.
- Never read a plan, a seat count, an amount or a permission from `custom_data`.
- `allowedPriceIds` checks the request before Paddle is called. It is not a limit on what the buyer finally pays for.
- Archive in Paddle every price that must not be sold.

## Documentation

| File | What is in it |
|---|---|
| [docs/setup.md](docs/setup.md) | The kit in simple words, install, environment variables, migrations, `createBilling` by hand, database clients, env validation, other frameworks, Paddle events to subscribe, and the integration checklist. |
| [docs/payments.md](docs/payments.md) | Checkout created on the server, the customer portal, prices from Paddle, shared seller accounts, the fulfilment module, hooks for one-time purchases and refunds, payment concepts, and plan state. |
| [docs/operations.md](docs/operations.md) | The resilient transport, the recovery job, the catalog CLI, moving an existing catalog, and monitoring. |
| [docs/limits-and-tests.md](docs/limits-and-tests.md) | Known limitations, what we tested and what we did not, the Kosovo payout note, and the scripts. |

Other files (UPGRADING.md, the starters, the changelog) name a section as "README, Monitoring" or "README Example". Those sections are now in the four files above.

Upgrade an app: [UPGRADING.md](UPGRADING.md). Every change: [CHANGELOG.md](CHANGELOG.md). What each version changed, in simple words: [docs/HISTORY.md](docs/HISTORY.md). Starters to copy: [examples/](examples). Team status (out of date since 2026-10-29): [STATUS.md](STATUS.md).

## Claude Code skill

`skills/integrating-paddle-kit/SKILL.md` tells an AI agent how to add the kit to an app: the decisions, the order of work, the sandbox test and the traps. Install it one time on each computer, and every project can use it:

```bash
ln -sfn ~/Desktop/Projects/paddle-kit/skills/integrating-paddle-kit ~/.claude/skills/integrating-paddle-kit
```

Then ask Claude Code to "add Paddle billing with paddle-kit" in any app. We tested the skill before we shipped it. Agents without it got 9–11 of 14 points on our integration checklist. With the skill, they got 13 of 14 (16 of 17 on the longer checklist).
