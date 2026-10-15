# paddle-kit — design spec

Date: 2026-10-15 · Status: draft for owner review

## 1. Purpose

One drop-in billing layer for every SnaxxTech **web** project that sells through
Paddle Billing: verified webhooks, subscription state kept in the project's own
database, a single `hasAccess(userId, feature)` check, and a checkout helper.
Each project today would otherwise rewrite this from scratch; none has Paddle yet.

**Owner decisions (2026-10-15):** full billing layer; framework-agnostic core;
pluggable storage, Postgres first; private GitHub repo consumed as a git
dependency pinned to a tag.

### Non-goals (v1)

- In-app purchases in the Expo/mobile apps. Google Play and the App Store require
  their own billing for digital goods; Paddle covers web checkout only.
- One-time purchases / license keys, usage-based billing, a customer-portal UI,
  Supabase or non-Postgres storage adapters. Deferred, see §11.
- Paddle Classic. Paddle Billing (v2 API) only.

### Open real-world constraint

Kosovo seller payout eligibility is **UNVERIFIED**. Paddle's sanctions page does
not list Kosovo as excluded and payouts can be in EUR, but no official statement
confirms payouts to a Kosovo seller. The owner confirms with Paddle (support or a
completed seller verification) before any live keys are used. The package can be
built and tested in sandbox regardless.

## 2. Package layout

Single TypeScript package, ESM, zero runtime dependencies in `core`.
Subpath exports:

| Export | Contents | Runtime |
|---|---|---|
| `paddle-kit/core` | `verifySignature`, `createWebhookHandler`, event normalisation, `createBilling` (`hasAccess`, `getSubscription`), config types | Any Web-standard runtime (Node 20+, Vercel Edge, Cloudflare Workers) |
| `paddle-kit/next` | `createNextRoute(billing)` → App Router `POST` handler | Next.js 14+ |
| `paddle-kit/hono` | `paddleWebhook(billing)` middleware | Hono |
| `paddle-kit/express` | `paddleWebhook(billing)` with raw-body handling | Node / Express |
| `paddle-kit/postgres` | `postgresStore({ sql })` + SQL migrations in `migrations/` | Any runtime with a Postgres client (Neon serverless, `pg`, `postgres`) |
| `paddle-kit/memory` | `memoryStore()` for tests and local dev | Any |
| `paddle-kit/client` | `openCheckout({ priceId, userId, email })` wrapping Paddle.js | Browser |
| `paddle-kit/reconcile` | `reconcile(billing)` — pulls state from the Paddle API | Node (uses `@paddle/paddle-node-sdk`) |

Adapters contain no business logic: each converts its framework's request into a
Web `Request` (raw body preserved), calls `core`, converts the `Response` back.

## 3. Configuration

```ts
const billing = createBilling({
  environment: 'sandbox' | 'production',
  webhookSecret: process.env.PADDLE_WEBHOOK_SECRET,
  store: postgresStore({ sql }),
  // price → features this price unlocks
  entitlements: {
    pri_01abc: ['pro'],
    pri_01def: ['pro', 'team'],
  },
  pastDueGraceDays: 7,
  signatureToleranceSeconds: 5, // default taken from the official SDK; see §9
});
```

Guards, enforced at construction (throw, not warn):
- `webhookSecret` missing or empty.
- `environment: 'production'` while `NODE_ENV !== 'production'`, unless
  `allowProductionInDev: true` is passed explicitly. Prevents live keys in local runs.

## 4. Webhook flow

1. Read the **raw** body as text. Never parse-then-reserialise.
2. Parse `Paddle-Signature: ts=<unix>;h1=<hex>[;h1=<hex>]`. Multiple `h1`
   values are allowed (secret rotation); any match passes.
3. Compute HMAC-SHA256 over `` `${ts}:${rawBody}` `` with the secret using Web
   Crypto; compare in constant time.
4. Reject if `|now − ts| > signatureToleranceSeconds`.
5. Parse JSON, normalise to an internal event (`eventId`, `eventType`,
   `occurredAt`, entity payload).
6. **Idempotency:** insert into `paddle_events` keyed by `event_id`; if it already
   exists with `status = 'processed'`, return 200 without reprocessing.
7. **Ordering:** for a subscription, apply the event only if its `occurred_at`
   is newer than the stored `last_event_at`; older events are recorded as
   `status = 'stale'` and acknowledged.
8. Upsert customer / subscription inside one transaction with the event row update.
9. Return 200.

Handled event types (v1): `subscription.created`, `subscription.updated`,
`subscription.activated`, `subscription.trialing`, `subscription.past_due`,
`subscription.paused`, `subscription.resumed`, `subscription.canceled`,
`customer.created`, `customer.updated`, `transaction.completed`.
Anything else is stored as `status = 'ignored'` and acknowledged with 200.

### User linking

The checkout helper passes `customData: { userId }`. Subscription events carry it
in `custom_data`. A subscription with no `userId` is stored with
`user_id = NULL` and its event marked `reason = 'no_user_id'` so it surfaces in
monitoring instead of silently granting nothing.

## 5. Access decision

`hasAccess(userId, feature)` is true if the user has any subscription where:
- one of its items' `price_id` maps to `feature` in `entitlements`, and
- `status` is `active` or `trialing`, or
- `status` is `past_due` and `now − past_due_since ≤ pastDueGraceDays`.

A cancellation scheduled for period end keeps the subscription `active` (with a
`scheduled_change`) until Paddle flips it, so access naturally runs to the end of
the paid period. `canceled` and `paused` grant nothing. `past_due_since` is not a
Paddle field: we set it on the first event that moves a subscription into
`past_due` and clear it when it leaves. The decision function is pure (takes subscriptions +
config + `now`) so it is unit-testable without a store.

## 6. Storage

`Store` interface (all methods async):
`recordEvent`, `markEvent`, `upsertCustomer`, `upsertSubscription`,
`getSubscriptionsByUser`, `getLastEventAt`, `withTransaction`.

Postgres schema, shipped as numbered SQL files in `migrations/`:

- `paddle_events(event_id PK, event_type, occurred_at, received_at, status, reason)`
  — `status ∈ received|processed|ignored|stale|failed`, `reason` is our own
  short code (never secret or driver text).
- `paddle_customers(customer_id PK, user_id, email, updated_at)`
- `paddle_subscriptions(subscription_id PK, customer_id, user_id, status,
  price_ids text[], current_period_end, past_due_since, canceled_at,
  last_event_at, raw jsonb, updated_at)`; index on `user_id`.

**Migration / wipe risk:** additive only, new `paddle_`-prefixed tables, no
change to any existing project table. Each project runs the migration itself;
the package never runs DDL automatically. Future schema changes ship as new
numbered files, never edits to shipped ones.

## 7. Errors

| Condition | Response | Recorded |
|---|---|---|
| Missing/malformed signature header | 400 | log `bad_signature_header` |
| Signature mismatch | 401 | log `signature_mismatch` |
| Timestamp outside tolerance | 401 | log `stale_timestamp` |
| Invalid JSON | 400 | log `bad_json` |
| Unknown event type | 200 | event `ignored` |
| Out-of-order event | 200 | event `stale` |
| Store failure | 500 (Paddle retries) | log `store_error`; event `failed` if writable |

Unauthenticated failures are logged, not stored (no DB writes from unverified input).

## 8. Monitoring (critical module)

1. **Alive:** `billing.health()` → `{ lastEventAt, lastFailureAt, lastFailureReason, failedLast24h }`.
   Each adapter exposes it as an opt-in GET route. Signal comes from real webhook
   traffic; no pinger (zero added compute on free tiers).
2. **Why it failed:** reason codes from §7, in the log line and in `paddle_events`
   (and in the log alone when the store itself is down).
3. **Where the owner sees it, how fast:** the health route (on demand), plus
   Paddle's notification-failure emails to the account owner. Worst case is
   bounded by Paddle's retry schedule — exact delay to be read from Paddle's
   docs during implementation and written into the README.
4. **Cost:** zero extra requests; one `paddle_events` row per webhook.
   `reconcile()` is opt-in, run by the project's existing cron; cost = one
   Paddle API list call per page of subscriptions.
5. **Drill (done-gate):** tests that send (a) wrong secret, (b) tampered body,
   (c) timestamp 10 min old, (d) store throwing, (e) subscription without
   `userId` — each must produce the right status code, reason code, and
   `health()` change.

## 9. Testing & acceptance

- **Signature oracle:** the official `@paddle/paddle-node-sdk` webhook verifier
  (dev dependency) must agree with `verifySignature` on valid, tampered,
  rotated-secret and stale fixtures. The default tolerance is read from that
  SDK's source, not assumed.
- **Real payloads:** fixtures captured from Paddle's sandbox webhook simulator,
  not hand-written. Ordering and duplicate tests replay them shuffled and doubled.
- **Pure access tests:** table-driven over status × grace × period end.
- **Store contract tests:** one suite run against `memoryStore` and against
  `postgresStore` on a real Postgres (local container or a Neon branch).
- **Runtime matrix:** core tests run on Node 20 and under an edge runtime
  (`@edge-runtime/vm` or Miniflare) to prove no Node-only API leaks into `core`.
- **End-to-end acceptance (owner-visible):** in one real project (proposed:
  offday), a Paddle **sandbox** checkout through a tunnel turns
  `hasAccess(user, 'pro')` from false to true; cancelling in the sandbox
  dashboard flips it back once Paddle reports `canceled` (use an immediate cancel in sandbox
so the check does not wait a billing period).
  Evidence: the `paddle_events` rows and the health output.

## 10. Distribution

Private GitHub repo `SnaxxTech/paddle-kit` (creation needs owner go-ahead).
Built output (`dist/`) committed on release tags only, so projects install with
`npm i github:SnaxxTech/paddle-kit#v0.1.0` without a build step. SemVer; breaking
changes to `Store` or config bump major.

## 11. Deferred

One-time purchases and license keys; usage-based billing; customer portal /
"manage subscription" UI; Supabase and SQLite adapters; per-seat quantities in
entitlements; multi-currency price display helpers.
