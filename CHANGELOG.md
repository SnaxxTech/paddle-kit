# Changelog

## 0.8.6 (2026-11-03)

The fulfilment module and an outbox (second review: "reusable fulfilment contracts … where apps supply only the
business action; for external work, write an outbox job in the same transaction"). **New migration
`005_fulfilment_outbox`** (CREATE-only, Postgres): run it before using the module; apps that do not use it are not
affected (its tables stay empty, and readiness checks them only with `readiness: { fulfilment: true }`).

### Added
- **`paddle-kit/fulfil`** (edge-safe, Postgres): `createFulfilment(db, { orderOf, grant, revoke, restore })` returns
  `onTransaction` / `onAdjustment` hooks. The kit keeps each payment's state (`held` / `granted` / `revoked`, and what
  the revoke took) and every adjustment, runs one payment's changes under an advisory lock in the app's transaction,
  and decides: a refund first keeps the payment from being granted; a reversal gives back what `revoke` returned;
  partial refunds, chargeback warnings and unfulfilled paid orders become `paddle_fulfilment_reviews` rows; replays
  and late, older statuses change nothing; subscription payments are skipped. A throw in the app's action rolls the
  whole payment back, so Paddle's retry grants exactly once.
- **Shaped by the first real consumer** (Slop Remover's Full Scan on this branch: its billing tests, 146 on PGlite and
  48/48 on real Postgres, pass on the module; 6 gaps it found are fixed here, each with a test that failed before):
  `orderOf(tx, q)` may be async and read the database inside the payment's lock; `grant` may return
  `{ declined: reason }` (state `declined`, a `declined:<reason>` review, later refunds change nothing); `revoke` /
  `restore` get `cause` (the adjustment behind them); `fulfilmentState(q, id)` reads a payment (state, grants, taken,
  `revokedBy`); `importFulfilment(q, …)` brings in payments fulfilled before the kit (a refunded one gets an
  `import:<id>` adjustment, so only a real reversal gives it back); a payment held because its refund came first raises
  a `held_payment` review; `createFulfilment(db, actions, { onReview })` is called once per new review.
- **Outbox:** `enqueue(q, { id, kind, payload })` in the same transaction (the id is the idempotency key);
  `drainOutbox(query, handlers, { limit, maxAttempts, leaseSeconds })` sends at least once with backoff and stores
  the error redacted; `outboxCheck(query)` is a health check (red for an item that gave up or waits > 60 min).
- **`createRecoveryRoute({ drainOutbox })`** runs the drain after recovery; its result is `outbox` in the response, a
  throw makes it a 500 with the error name only.
- **`readinessChecks({ fulfilment: true })`** / `billingFromEnv({ readiness: { fulfilment: true } })` checks migration
  005's tables and columns; `Store.checkSchema(extra?)`.
- README: "Fulfilment module", with a credit-pack `lib/credits.ts` that a test runs as written; the credit preset
  points to it. The hand-written examples stay (and stay tested).

### Tests
- `tests/fulfil.test.ts` (PGlite): every scenario of the hand-written examples through the module (grant by quantity
  once, buy 5 / spend 3 / refund / reverse = 2, chargeback and won dispute, refund before payment, a won chargeback
  while a refund stands, late older status, reviews, subscription payments skipped, a throwing action rolled back),
  an unlock, and the outbox (once per key, backoff, redaction, give-up, `outboxCheck`, no handler).
- Real Postgres 17 (`tests/pg-concurrency.test.ts`): payment + refund + chargeback + won dispute racing on separate
  connections end at 0 credits in 20/20 rounds (without the advisory lock: 5 credits, the test fails); four drains
  racing send each of 40 items exactly once. That test also passed with the claim's `SKIP LOCKED` and recheck removed,
  so it does not isolate them; they stay as the standard pattern.

## 0.8.5 (2026-11-03)

### Fixes
- **`checkout.openTransaction(transactionId, { email })`**: prefills the email field for a first purchase. Opening a
  server-created transaction with no customer showed an empty email field, where `open({ email })` had prefilled it
  (seen in the Paddle sandbox overlay while integrating QR-Lab). Passing `customer.email` with the transaction id fills
  it, checked in the same overlay. No change without `email`.

## 0.8.4 (2026-11-03)

Checkout created on the server, and the customer portal (second review). No migration; nothing changes unless an app
uses them.

### Added
- **`paddle-kit/server`** (edge-safe, server only): `createCheckoutTransaction(api, { userId, items, customerId?,
  customData?, allowedPriceIds? })` creates an automatically-collected transaction whose `custom_data.userId` is always
  the server's `userId`, checks items (whole quantities, allowed prices) before calling Paddle, and returns
  `{ transactionId, checkoutUrl }`. `customerPortalSession(api, { customerId, subscriptionIds? })` returns the
  overview and per-subscription links and throws for any link not on Paddle's portal host. `api` refuses a key of the
  other environment. Errors are `PaddleError` (status and Paddle's code, never the key).
- **`checkout.openTransaction(transactionId)`** in `paddle-kit/client` opens the checkout for a server-created
  transaction.
- README: "Checkout created on the server, and the customer portal", with a server-action example that a test runs as
  written. Checked against the Paddle sandbox: the transaction kept the server's `userId` when `customData` tried to
  set another, its items and customer matched, an unknown price gave `PaddleError` 400, and every portal link was on
  `sandbox-customer-portal.paddle.com`.

## 0.8.3 (2026-11-03)

One product definition for access and checkout (second review). No migration; nothing changes unless an app passes
`products`.

### Added
- **`defineProducts(prices, products)`** (`paddle-kit/config`) and **`billingFromEnv({ products })`**: product key →
  `features` and `retiredPriceIds`. Entitlements are every price on sale plus every retired one; `owns` gains the
  retired ids (ownership and "still grants" stay separate: a retired id is listed on purpose); checkout reads only the
  prices on sale (`products.checkoutPriceId('pro', 'monthly')`); `productOf(priceId)` names the product, cycle and
  whether the price is retired. Product keys are required prices, so a missing one is a named env problem (billing off),
  never a throw at import. Fixes the known limit "a renewal on a retired price that is not in `entitlements` loses
  access" for apps that list the retired id (test: a signed renewal on a retired price had no access before, has it now).
- The README Quickstart uses `products`.

### Notes
- Measured for the 0.8.2 readiness check: a cold `GET /` to Paddle from a fresh Node process took 342-904 ms (6 runs,
  host load ~13), so the 3 s `healthCheckTimeoutMs` default stays. A >3 s first check seen on a local `next dev` server
  was the route compiling.

## 0.8.2 (2026-11-03)

The second review's next two items: a readiness check, and the Quickstart's three presets as tested examples. No
migration, nothing changes unless an app opts in.

### Added
- **`readinessChecks`** (`paddle-kit/config`) and **`billingFromEnv({ readiness })`**: health checks that turn health
  and `paddle-kit-doctor` red before the first payment needs something: `paddle_api_key` (one cached `GET /` to Paddle:
  the key is accepted and has the permissions recovery needs, plus `price.read`/`product.read` with `resolvePrices`,
  plus any `permissions` you name; one request per instance even when checks overlap), `migrations` (every table and
  column the kit uses, from `REQUIRED_SCHEMA`; a database that does not answer is reported as that, not as a missing
  migration) and `cron_secret` (set, 16+ characters). Details name permissions, tables and variables only.
- **`Store.checkSchema()`** on the Postgres (`information_schema`, current schema) and SQLite (`pragma_table_info`)
  stores: the required tables and columns that are missing. A test keeps `REQUIRED_SCHEMA` equal to what the migrations
  create on both. Checked against the real Paddle sandbox: a good key passed
  (6 permissions), a made-up key and a sandbox key sent to live were refused (403).
- **Three presets** in the Quickstart: subscription (the setup as is), one-time unlock (new README example
  `unlockHooks` / `hasUnlock`), credit packs (the existing example). `tests/readme-presets.test.ts` runs the README's
  `lib/billing.ts` + `lib/policy.ts` end to end with signed subscription events, and the unlock example's wiring,
  webhook and `canUse` on PGlite (refund before payment, reversal, replay, partial refund). A paid order with no user or
  a price that unlocks nothing is kept in `unlock_reviews`, once per payment, never just logged.

## 0.8.1 (2026-11-03)

Fixes the README copy-paste traps the second review of 0.8.0 found. Each fix has a test that runs the README block as
written and failed before. **No `paddle_*` migration**, and no behaviour change for apps that did not copy these
examples. **Apps that copied the credit-pack example need an app-side schema change:** add `orders.revoked` and
`orders.taken`, adopt the new `settle`, and review orders revoked under the old example (UPGRADING 0.8.1, step 3).
The Quickstart imports `priceIds` and `createRecoveryRoute`, which exist from 0.8.1 on.

### Fixes
- **Price maps (README Quickstart).** The entitlements example split a flat `PADDLE_PRICES` entry (`{ "pro": "pri_pro" }`)
  into single characters (`_ i o p r`), so nobody got access. New helpers in `paddle-kit/config`: `priceIds(entry)`
  (every id of an entry, either form) and `priceIdOf(prices, key, cycle?)` (one id, or a clear error). The README's
  examples use them instead of `Object.values(...)` and `as string`; `readBillingEnv` uses `priceIds` too.
- **Recovery route.** The README route let `Bearer undefined` in while `CRON_SECRET` was unset, and answered 200 `off`
  for a misconfigured app, hiding a recovery job that never ran. New `createRecoveryRoute` in `paddle-kit/reconcile`:
  401 without the secret (and always while it is unset), 500 `misconfigured` with the problem names for env problems or
  a missing `PADDLE_API_KEY`, 200 `off` only when billing is deliberately off, 500 for a failed run.
- **Credit example: a reversed refund gave back the full pack.** Buy 5, spend 3, refund (takes the 2 left), reverse:
  5 came back instead of 2. Orders now record what a revoke actually took (`revoked`, `taken`), and a give-back returns
  exactly that; the account row is locked while a payment settles. Apps that copied the example: see UPGRADING.

### Docs
- The README starts with one Quickstart (the supported setup). The `createBilling`-by-hand section says what it skips;
  its duplicate one-call block is gone. Version notes moved to `docs/HISTORY.md`.
- Stated: one set of `paddle_*` tables per app and per environment (the tables have no app or environment column).

## 0.8.0 (2026-11-03)

Fixes the four gaps the 2026-11-03 review of 0.8.0-qr.1 reproduced, each with a test that failed before and passes
after, and makes the safe path the default. **New migration `004_claim_tokens_owned_ids`** (CREATE-only). Upgrade steps:
[UPGRADING.md](UPGRADING.md).

### Fixes
- **Refunds and credits (README example).** The credit-pack example granted 5 credits when a full refund had arrived
  before its payment, and gave 5 back on a won chargeback while a separate full refund still stood. It now keeps every
  adjustment against its transaction (a status only moves forward), runs one payment's changes under a per-transaction
  advisory lock, and derives the grant from the adjustments that still stand. New `paymentRevoked(adjustments)` in
  `paddle-kit/core`. `tests/readme-hooks.test.ts` reads the SQL and TypeScript blocks out of README.md and runs them as
  written (PGlite), and a real-Postgres test races a payment, refund, chargeback and reversal on separate connections.
- **Claim ownership.** An attempt whose lease had expired could fail late, mark the event `failed` and delete its
  replacement's claim, so a third delivery ran the hooks while the replacement still ran. `recordEvent` takes a
  `claimToken` (the handler sends a fresh UUID); `markEvent(…, claimToken)` writes the status and releases the claim only
  while that token owns it, atomically, and returns `false` otherwise. The handler then answers 409 and records the
  failure in health. Both new parameters are optional: custom stores keep compiling (unconditional, as before).
  Claims move to the new table `paddle_event_leases` (Postgres and SQLite); `paddle_event_claims` is no longer used.
- **Historical ownership.** With prices found by label, `owns` knew only the prices on sale now, so a late payment or
  renewal on an archived or replaced price was acked 200 `not_ours` and never fulfilled. Ownership is now separate from
  the price map: stores keep every owned price and product id for good (`addOwnedIds` / `getOwnedIds`, table
  `paddle_owned_ids`), the new `syncOwnership(billing, { apiKey, app })` fills them from Paddle (active **and** archived
  prices of the app's labelled products), and `recoverBilling` runs it first when `billing.config.catalogApp` is set.
  `billingFromEnv` with `resolvePrices` decides ownership from the store alone: no Paddle call in the webhook path;
  with no ids yet it answers 503 `prices_unavailable`, never `not_ours`.
- **Recovery validation.** An adjustment without a valid `updated_at` / `created_at` compared false against `since`
  and was dropped as old; recovery reported `done` and moved its checkpoint. Entities are validated before the date
  filter and counted in the new `PaymentCounts.invalid`; any invalid record makes `recoverBilling` `failed` /
  `incomplete`, keeps the checkpoint, and returns the partial counts (`subscriptions`, `payments`, `events`,
  `remainingPending`, `ownership`) with the failure.

### Safe path by default
- `billingFromEnv` creates one `createPaddleTransport()` and uses it for price lookups and, via the new
  `BillingConfig.paddleFetch`, for `reconcile`, `reconcilePayments`, `recoverBilling` and `syncOwnership` (a call's own
  `fetch` still wins). It returns it as `transport`.
- `billingFromEnv` returns `enforce` (`BILLING_ENFORCE === '1'`) even when the env is broken, so the app can refuse paid
  operations instead of serving them free.
- Health reports `recovery` (`status`, `reason`, `lastSucceededAt`, `checkpointAt`, `checkpointAgeSeconds`; `null`
  when the job never ran). `paddle-kit-doctor` turns red when the job never completed or has not completed for 26 h.
- README: **Standard setup** (one config, one webhook route, one scheduled recovery job, one policy module) and the
  rules every app follows.

### Known limits (follow-ups)
- Recovery still re-reads the whole adjustment list each run (no resumable/incremental paging).
- `entitlements` are keyed by price id: keep a retired price in `entitlements` while subscriptions on it still renew.

## 0.8.0-qr.1 (unreleased candidate)

- Add opt-in `createPaddleTransport`: bounded JSON deadlines, safe GET retries with jitter/Retry-After, an in-process
  circuit breaker with one half-open probe, redirect/origin protection, and sanitized transport errors.
- Add `recoverBilling`: durable checkpoint/lease, original event replay via the documented event stream, snapshot/payment
  repair, explicit partial failure, and a bounded job. **Run migration 003_recovery before enabling it.** All built-in
  stores expose `recovery`; custom stores may provide an adapter. No app scheduler is created automatically.
- Fail instead of silently truncating paginated reads. Health exposes unresolved failures/unfinished work, and doctor
  evaluates these independently of the last failure reason and distinguishes stale owned traffic.
- Apply provider subscription grace transitions atomically in built-in stores. Stale snapshots no longer backdate grace;
  the tradeoff is conservative extra grace if the first overdue snapshot arrives late. Low-level upsert remains unchanged.
- QR Lab is the first consumer under verification; other app integrations are unchanged. This candidate is not tagged or published.


## 0.7.0 (unreleased)

Upgrade steps: [UPGRADING.md](UPGRADING.md). No new migration. Fixes the three items the 2026-10-29 review confirmed (A1–A3), plus prices found by label and multi-app monitoring.

### Behaviour changes
- **Live destinations take real events only (review A1).** The catalog CLI created every destination with `traffic_source: "all"`, so a live destination also took simulated events, which are signed with the real secret and can be sent by anyone with dashboard access. With a `pdl_live_` key it now creates `"platform"` and **moves an existing live destination to `"platform"`** on the next run (one PATCH). Sandbox keeps `"all"` (the simulator needs it), and a sandbox destination set to anything else is set back. Paddle's default when the field is omitted is `platform`.
- **Refused requests no longer write to the store (review A2).** A missing or oversized body, a missing or bad `Paddle-Signature`, and a timestamp out of the window (`missing_body`, `body_too_large`, `bad_signature_header`, `signature_mismatch`, `stale_timestamp`, `future_timestamp`) are answered as before (400/401/413) but make **zero store calls**: before, each wrote a `paddle_failures` row, so a bot on the URL kept a serverless Postgres (Neon) awake. They are counted in the server instance's memory and shown in health as `unverified: { since, count, byReason, lastAt, lastReason }`, with at most one warn log line a minute (new optional `LogEntry.count`: refusals since the last line). Signed requests that fail (`bad_json`, `bad_payload`) and failed events are still recorded. So `lastFailureReason` / `failedLast24h` no longer show a wrong secret: judge it by an old `lastEventAt` (`paddle-kit-doctor --stale-hours`).
- **Future timestamps are refused**: a signature more than `clockSkewSeconds` (new, default 60) ahead of the server clock is 401 with the **new reason code `future_timestamp`**. The SDK accepted any future timestamp, and so did the kit.
- **New reason code `prices_unavailable`**: 503 when an `owns` resolver cannot find the app's price ids (see below). Two new `ReasonCode` members break an exhaustive `switch` that ends in a `never` check.
- `PriceErrorCode` gains `ambiguous`.

### Prices found by their label (C)
- `findPrice({ app, key, cycle }, { apiKey, environment, fetch?, timeoutMs? })` in `paddle-kit/price` lists the active prices (`include=product`, pinned `Paddle-Version: 1`, all pages, redacted errors) and returns the one the catalog CLI labelled `<key>-<cycle>` on the product labelled `app`, as `getPrice` does. `PriceError` `not_found` (none) or `ambiguous` (more than one). `findPriceMap(app, opts)` returns all of them as the `PADDLE_PRICES` map.
- `readBillingEnv(env, { …, resolvePrices: { app, cacheSeconds?, fetch?, timeoutMs? } })`: `PADDLE_PRICES` may be unset (then `PADDLE_API_KEY` is required). The result adds `config.resolvePrices()` (the map, looked up and checked against `requiredPrices` / `requiredCycles`; kept `cacheSeconds`, default 600, per instance; failures not kept), and `config.owns` becomes a resolver. A set `PADDLE_PRICES` is the override. Without the option, behaviour and types are unchanged (an overload).
- `createBilling({ owns })` and `reconcile` accept an `OwnsResolver` (`{ resolve(): Promise<OwnedIds | OwnsPredicate> }`), awaited per event; a predicate lets an app with its own `owns` function (LeakScan matches its `order_id` too) build it from the ids found by label. A lookup that throws, times out (`hookTimeoutMs`) or finds no id answers **503 `prices_unavailable`** and marks the event `failed`, so Paddle retries; nothing is ever marked `not_ours` (or mirrored as "owns everything") because a lookup failed. `reconcile` throws before reading any subscription.

### Monitoring (D, E)
- `createBilling({ healthChecks: { [name]: () => Promise<{ ok, detail? }> }, healthCheckTimeoutMs? })`: app checks on the authenticated health route, in parallel, each with a timeout (default 3000 ms). A throw, a timeout or a non-result is `{ ok: false }`; the error goes to `onError`, never into the report. Shown as `checks` in health. New exported types `HealthReport`, `CheckResult`, `UnverifiedStats`, `ErrorContext`, `OwnsResolver`.
- `paddle-kit-doctor --apps apps.json [--json]`: the file lists `{ name, url, tokenEnv, staleHours? }`; each token comes from the variable `tokenEnv` names (an entry with `token` is refused). A table (reachable, env, last verified event and its age against `staleHours`, failures in 24 h with the last reason, app checks) or one JSON result per app for a scheduled job. Exit 0 all green, 1 any app red, 2 a bad file or flags (nothing checked). Single-app mode is unchanged and gains `--stale-hours` and `--json`. **`--html <file>`** writes a self-contained status page (summary, then a card per app, red first; no script, no external file, no token; light and dark), for billing-watch to publish behind a login. It shows the `unverified` counts (a `signature_mismatch` among them is a warning) and app checks, and treats a recent `prices_unavailable` as a problem. Never prints a token.

### Payments: reconciliation, chargebacks, setup
- **`reconcilePayments(billing, { apiKey, since, fetch? })`** in `paddle-kit/reconcile`: repairs lost payment and refund webhooks. Reads completed transactions (`updated_at[GTE]`) and adjustments updated since `since`, and replays each through the webhook's own ledger path (new internal `process` step of the handler) as a delivery with its own event id (`reconcile_txn_<id>`, `reconcile_adj_<id>_<status>`): `owns`, hooks, claims and dedup apply as for a webhook, and a second run is a no-op. An adjustment of a transaction the store never saw replays that transaction first. Returns `{ transactions, adjustments }`, each `{ scanned, applied, duplicates, notOurs, failed }`. `reconcile` (subscriptions) is unchanged.
- **`adjustmentEffect(adj)`** in `paddle-kit/core`: `revoke` (approved full refund, chargeback), `restore` (`chargeback_reverse`, a reversed refund or chargeback), `review` (partial refund, `chargeback_warning`, anything unknown) or `none` (pending, rejected, credits, `chargeback_warning_reverse`), from Paddle's documented actions and statuses. The README's hooks example uses it and is now a test on real SQL (`tests/readme-hooks.test.ts`).
- **`billingFromEnv(env, { requiredPrices, store, entitlements?, …createBilling options })`** in `paddle-kit/config`: `readBillingEnv` + `createBilling` in one call, with every webhook secret, the health token and `owns` filled in; `billing` is null while billing is off or misconfigured. `entitlements` may be a function of the config.
- README: a "Payment concepts" map (what the kit does, what Paddle does as merchant of record), and patterns for an outbox and a credits ledger in the app.

### Should-fix (B)
- `onError(error, ctx)`: the original error of a failed hook, `owns`, price lookup, store call or app check, with `ctx.reason` (and `eventId` / `eventType`). The kit still logs only reason codes. A throwing or rejecting `onError` changes nothing.
- `webhookSecret` takes an array: a request signed with any of them is verified (rotation without downtime). `readBillingEnv` reads several comma-separated secrets from `PADDLE_NOTIFICATION_WEBHOOK_SECRET` into the new `config.webhookSecrets` (`webhookSecret` stays the first).
- The health token is compared with a new length-independent constant-time compare (both sides hashed with SHA-256 first), in `handleHealth` and `createWebhookRoute`.
- `hookTimeoutMs` and `storeTimeoutMs` (optional, off by default): a slower hook is a `hook_error`, a slower store call a `store_error` (webhook, health and `hasAccess`). A timed-out hook is not cancelled.
- Docs: the retry table now says what Paddle says (live: up to 60 tries in about two days; sandbox: 3 tries within about two minutes; it said about 3 days and about 15 minutes); README, skill and catalog notes say `traffic_source: all` is for sandbox only; hooks run **at least once** (said plainly in the README and the JSDoc); the `upsertCustomer` / `Customer` comments no longer claim a removal in 0.6.0 (they stay, deprecated, until a release marked BREAKING); this file dated 0.6.0; the README no longer says CI is off.
- Tests: the drill now proves zero store calls for every pre-signature refusal (500 unsigned and forged POSTs: no store call, one log line); two shared-seller tests signed events 19 days ahead of their own clock and are fixed.

## 0.6.0 (2026-10-29)

Upgrade steps: [UPGRADING.md](UPGRADING.md). No new migration. Additive: nothing is removed, and no existing response changes.

- **New `paddle-kit/price`** (edge-safe): `getPrice(priceId, { apiKey, environment, fetch?, timeoutMs? })` reads `GET /prices/{id}` with `Paddle-Version: 1` and returns `{ id, amount, currency, interval, name, status }`. Errors are `PriceError` (extends `PaddleError`) with `code` `unauthorized` (401/403 or a key for the other environment), `not_found` (404 or an id that is not `pri_…`), `timeout` (default 5 s, the request is aborted), `network`, `malformed` or `http` (other statuses, in `status`); the message never has the key. `formatPrice(amount, currency, locale = 'en-US')`: whole amounts without cents (`$15`, `$9.99`), zero-decimal currencies not divided by 100. No caching in the kit; the README shows Next.js 16 `"use cache"` + `cacheLife('hours')` with a built-in fallback. Why: LeakScan kept its price in code and in Paddle, so a price change needed two edits.
- **New `createWebhookRoute({ billing, problems, healthToken? })` in `paddle-kit/next`**: the null-safe route that the README and the skill had as hand-written code. Billing on: `handleWebhook` / `handleHealth` (GET 404 `{ "error": "health_off" }` without a health token). Billing off: 404, GET `{ "error": "billing_off" }`. Misconfigured: 503, and a GET with the health token gets `{ "error": "misconfigured", "problems": [...] }` (names only). It never builds billing. `createNextRoute` is unchanged.
- **New `paddle-kit-doctor` bin**: `--url <route> --token <PADDLE_HEALTH_TOKEN>` (or the env variable) calls the deployed health route and prints reachable or not, billing on/off, environment, kit version, env problems by name, last event time and the last failure reason in plain words. Exit 1 on a problem (not reachable, redirect, refused token, billing off, health off, misconfigured, `store_error`, or a `signature_mismatch` / `store_error` / `hook_error` in the last 24 h). It does not follow redirects, so the token stays on that host; https only, except localhost.
- **Catalog CLI prints a host block** after each run (not after `--teardown`): `PADDLE_ENV`, `PADDLE_PRICES`, `PADDLE_NOTIFICATION_WEBHOOK_SECRET`, `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` from the env file, the secret as a comment with its last 4 characters unless `--show-secrets`. `--host vercel` adds `vercel env add <NAME> <environment>` lines (sandbox: preview and development; `--live`: production), never run. Why: a production app had checkout off because `PADDLE_PRICES` and the client token were only in `.env.local`.
- **npx outside an app**: the README explains the npm E404 (the kit is not on the registry) and the two ways that work. Run from the npx cache in a folder whose `package.json` does not depend on the kit, the catalog CLI prints one line that says so.
- `PaddleError` has an optional `status` (the HTTP status of a Paddle error answer). `FetchLike`'s init may carry a `signal`.
- `Store.upsertCustomer` and `Customer` stay deprecated (0.5.0 said "until v0.6.0"); they are not removed in this additive release.

## 0.5.0 (2026-10-20)

Upgrade steps: [UPGRADING.md](UPGRADING.md). No new migration.

- **Public repository.** Install with `npm i github:SnaxxTech/paddle-kit#v0.5.0` and no token. The history was scanned before the change (gitleaks 8.30.1 over all 79 commits, plus a pattern search for Paddle keys, webhook secrets, client tokens, GitHub tokens and database URLs): no real secret. Apps keep their secrets in their own env files.
- **Paddle API version pinned to 1.** Every REST call (`reconcile`, catalog CLI) sends `Paddle-Version: 1`. Before, Paddle answered with the account's default version, so a new default could change the shapes the kit reads. The catalog CLI creates the destination with `api_version: 1` and sets it on an existing destination with another version.
- **Health has `kitVersion` and `environment`**, so one monitor can show which app runs which kit version against which Paddle account. The route adds them; `Store.health` is unchanged.
- CI is on (`.github/workflows/ci.yml`), and Dependabot checks npm packages and GitHub Actions each week.
- Health gains `lastOwnedAt` (the last event that `owns` matched: a processed event with reason `null` or `no_user_id`) and `notOursLast24h` (events acked as `not_ours` in 24 h), from existing `paddle_events` rows: no migration. A wrong `owns` used to look fully green; README Monitoring has the alert rule. New reasons, both `processed`, hook still run, no warn line: `mirrored` (kept only because its subscription is already mirrored; `owns` did not match; adjustments of such a subscription too; it replaces `no_user_id` on those events) and `unmatched` (an adjustment with `ctx.known === false`, which was `null`). `owns` now also runs for events of mirrored subscriptions, so a throwing predicate fails those events too. Both health fields are optional in the `Health` type, so custom stores keep compiling.
- **No more foreign customer emails.** `customer.created` / `customer.updated` are acknowledged 200 and recorded as `ignored` / `unknown_event`; nothing is written to `paddle_customers`. Before, every customer event was stored before any `owns` check, so on a shared seller account each app kept every other app's customer emails, and the kit never read them. `customer` is gone from `EVENT_TYPES`, so the catalog `EVENTS` list has 13 events and the next `paddle-kit-catalog` sync unsubscribes an existing destination from `customer.*`. `Store.upsertCustomer` and the `Customer` type stay, deprecated, until v0.6.0. Existing `paddle_customers` rows are not deleted: see UPGRADING.
- The webhook stops reading a body at 4 MB (`MAX_WEBHOOK_BODY_BYTES`) and answers 413 with the new reason code `body_too_large`, before the signature is checked. It used to read any size into memory. The cap holds when `content-length` is missing or wrong. `createBilling({ maxBodyBytes })` lowers or raises it. The body is decoded once, after the read, so the signature sees the same text as before.

## 0.4.0 (2026-10-16)

Upgrade steps: [UPGRADING.md](UPGRADING.md). **Run migration `002_claims_transactions` before deploying.**

### BREAKING: removed (no SnaxxTech app used them; each has a replacement in UPGRADING.md)
- `paddle-kit/express` and `paddle-kit/hono`, with `Billing.recordFailure`, `Billing.log` and the reason code `missing_raw_body` (only the Express adapter used them). Peer dependencies `express`, `hono` and `@paddle/paddle-node-sdk` are gone; `@paddle/paddle-js` (client) is the only peer left.
- `reconcile` no longer uses the Paddle Node SDK: it reads `GET /subscriptions` with `fetch` and maps through the webhook's own `subscriptionFrom()`. Options `{ apiKey, fetch? }` (the `client` option, `SdkSubscriptionLike` and `fromSdkSubscription` are gone); returns `{ scanned, applied, notOurs, invalid }`. **Fixes** reconciled rows: `raw` was the SDK's camelCase object (so line items and custom data read wrong), `status` skipped the status check, and `userId` skipped the control-character filter. A reconciled row now deep-equals the webhook row apart from `lastEventAt`. reconcile is now edge-safe.
- `itemsOf`, `customDataOf`, `verifySignature`, `VerifyResult`, `decideAccess`, `AccessPolicy` are no longer exported from `paddle-kit/core` (only `createBilling` and the types are).
- `Billing.getSubscriptions()` and `Billing.health()`: use `billing.store.getSubscriptionsByUser(userId)` and `billing.store.health(new Date())`.
- `createBilling({ signatureToleranceSeconds })`: tolerance is fixed at 5 s.
- Client `open({ priceId, quantity })` shorthand and `successUrl`: pass `items` (`[{ priceId, quantity }]`); navigate on Paddle.js `checkout.completed`.
- The `migrations/*.sql` files: `MIGRATIONS` from `paddle-kit/postgres` is the only copy. The `"import"` export condition is gone (`"default"` resolves the same ESM files).
- Not removed: `PlanInput.exempt` (Offday passes `exempt: demo`, and its demo-is-free test depends on it).

### Fixes and small changes
- `PADDLE_HEALTH_TOKEN` with leading or trailing whitespace is a `readBillingEnv` problem (never echoed), like the other secrets.
- The catalog CLI's summary prints amounts in the currency's own minor unit (¥1500 was shown as "15.00 JPY").
- Internal: catalog `EVENTS` is derived from one `EVENT_TYPES` record (same 15 events; the name stays); one `PriceMap` declaration; the CLI's duplicate https check is gone (syncCatalog checks before any request); `clone` wrapper and tsup `external` removed; the Paddle REST client is shared by catalog and reconcile.

### Shared seller accounts
- New `createBilling({ owns })`: `{ priceIds?, productIds? }` or a predicate `({ kind, items, customData }) => boolean`. Subscription and transaction events with none of them are acknowledged and recorded as `ignored` with the new reason `not_ours`: never mirrored, no hook, not a failure in health, no warn line. A subscription already in the mirror stays ours; so does a transaction on a mirrored subscription. An `owns` object without ids throws; a throwing predicate fails the event as `hook_error`.
- Every transaction seen is remembered with its ownership (new table `paddle_transactions`; optional `Store.recordTransaction` / `getTransaction`, implemented by all three kit stores). An adjustment of a transaction seen as someone else's is `not_ours`. An adjustment of a transaction never seen is **not dropped**: `onAdjustment` gets it with the new `ctx.known === false` (a refund can arrive before its payment).
- `readBillingEnv` returns `config.owns = { priceIds }` with every id in `PADDLE_PRICES` (absent for an empty map).
- `reconcile` mirrors only our subscriptions (or ones already mirrored) and returns `{ scanned, applied, notOurs }`.

### Idempotency under concurrency
- Behaviour change: duplicate deliveries of an event that arrive while another delivery is running its hooks answer **409 `{ "error": "in_progress" }`** instead of running the hooks again (50 parallel deliveries ran `onTransaction` 50 times in 0.3.1). Claims live in the new table `paddle_event_claims`, so the ledger row keeps its `failed` status and `received_at` during a retry. A failed attempt releases its claim at once; a claim older than the new `eventLeaseSeconds` (default 60) is taken over as a crashed attempt. `Store.recordEvent` takes an optional `leaseExpiredBefore` and may return `inProgress`; a custom store that ignores both keeps the 0.3 at-least-once behaviour.
- New real-Postgres suite `npm run test:pg` (N=50 parallel duplicates, shuffled parallel `subscription.updated`, flaky-hook redeliveries, 1,000-event load with p95 and a sample-count reconciliation). It skips with a loud SKIP line when no server is available, and fails in CI (`PADDLE_KIT_REQUIRE_PG=1`) instead of skipping.

### Tooling
- `UPGRADING.md`; CI workflow, shipped disabled at `docs/ci-workflow.yml` (enabled in 0.5.0): typecheck, tests, build, edge check, the packed-tarball smoke check in a scratch app (now also checks that `paddle-kit/hono` and `paddle-kit/express` no longer resolve), and the Postgres suite against a `postgres:16` service. The real-Postgres suite prints the server version.
- `npm run smoke` now also runs a signed webhook through the installed tarball (`owns` filtering and a known/unknown refund).

## 0.3.1 (2026-10-16)

- Every subpath export now has a `default` condition (same ESM files), so CommonJS-style resolvers (Playwright test runner, tsx, Jest) can resolve `paddle-kit/*`. Found by Offday's Playwright suite; `npm run smoke` now checks `require.resolve` for every subpath.

## 0.3.0 (2026-10-16)

Additive; every v0.2 test passes unchanged except the one assertion about the event kind of `transaction.completed`.

### Hooks
- New normalised event kinds `transaction` and `adjustment`, and optional `onTransaction` / `onAdjustment` hooks in `createBilling`.
  Hooks run at least once per verified event, after the event is recorded and before it is marked processed.
  `onTransaction` fires only for `transaction.completed`; `transaction.paid` is recorded without a hook.
  `transaction.completed` also fires for subscription renewals: one-time handlers filter `tx.subscriptionId === null`.
  `Transaction` and `Adjustment` carry `total` (tax-inclusive) and `subtotal` as lowest-unit strings.
  `subtotal` is before discount and tax (net of tax for tax-inclusive prices): verify an order by `tx.items` (priceId, quantity) and record the currency (Paddle may localise it; don't require it), since the catalog price fixes the amount; write order + grant in one DB transaction; and don't equality-check either amount against a list price.
  `onAdjustment`: key side effects on `adjustmentId` + `status`, act on refunds only when `status` is `approved`, and find your order by `transactionId`.
- `itemsOf(subscription)` and `customDataOf(subscription)` read line items (price, product, quantity) and the full custom data from a stored subscription.
- `createCheckout().open({ customData })`: extra custom data is sent with the checkout; `userId` always comes from `userId` and cannot be overridden.
- New reason code `hook_error`: a throwing hook fails the event (HTTP 500, visible in health) so Paddle retries. Store failures keep `store_error`. `ReasonCode` gained `hook_error`, which breaks exhaustive `switch` statements that end in a `never` check.
- `Adjustment.type` (`'full' | 'partial' | null`, from Paddle's `type`) lets a handler tell full refunds from partial ones. A recovered `hook_error` / `store_error` disappears from health after a successful retry.
- Behaviour change: `transaction.paid`, `adjustment.created` and `adjustment.updated` are now `processed` (record-only without hooks); in v0.2 they were stored as `ignored`.
- Behaviour change: a `transaction.*` payload without `data.id`, or an `adjustment.*` payload without `data.id` or `data.transaction_id`, now answers 400 `bad_payload`. In v0.2 a `transaction.completed` without `data.id` was processed.

### Plan state and env validation
- New `paddle-kit/plan`: `planOf()` returns `free | paid | trial | expired` from exemption, account age, launch date and subscription. `trialDays: 0` with a future `launchAt` is `expired` immediately: gate enforcement on the launch; apps with a free tier treat `expired` as "free limits", not a lockout.
- New `paddle-kit/config`: `readBillingEnv()` validates the billing environment, silent when nothing is set (build-safe), never echoes a value in a problem string. Options: `requiredPrices`, `requiredCycles` (cycles every nested required entry must have), `requireLaunchAt`. Whitespace-only values, and a secret, price id or client token with leading or trailing whitespace, are problems (never echoed); an invalid `PADDLE_ENV` is reported without derived token mismatches.

### Catalog CLI
- New `paddle-kit-catalog` binary and `paddle-kit/catalog` library: syncs a sandbox product, prices (monthly, yearly, one-time), notification destination and client token from `paddle.catalog.json`, idempotently, and writes `PADDLE_ENV`, `PADDLE_PRICES`, `PADDLE_NOTIFICATION_WEBHOOK_SECRET` and `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` to an env file (mode 0600). Flags: `--catalog`, `--webhook-url` (full endpoint URL), `--env-file`, `--teardown`, `--live`. Resources are found by markers (`custom_data.paddle_kit`, `paddle_kit_price`, destination `<app> (paddle-kit)`). Redacts secrets and refuses live/test mixes before any request.
- An app with a catalog from an older script must tear it down (or deactivate its destination) first; see the README migration section.

### Tooling
- `scripts/check-edge.mjs` now also catches `node:`-prefixed builtins that the bundler strips.
- README: hooks, plan state, env validation, catalog CLI, migration, monitoring and an integration checklist.
