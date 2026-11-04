# Upgrading paddle-kit

## 0.9.2 (from 0.9.1)

1. **Production enforcement is on by default.** With `PADDLE_ENV=production`, a broken billing config now refuses paid
   features. Set `BILLING_ENFORCE=0` only if you really want the old fail-open behaviour.
2. **Archive retired prices in Paddle.** The new `retired_prices` health check is red while one is still active, and
   needs the API key's `price.read` permission.
3. **`paddle-kit-doctor --apps`:** rename each `tokenEnv` to end in `_HEALTH_TOKEN` (e.g. `QRLAB_HEALTH_TOKEN`).
4. **Subscription apps:** to end access on a full refund or chargeback, copy the subscription starter's `onAdjustment`
   (calls `cancelSubscription`; the key needs `subscription.write`).
5. **Copied starters:** take the new `lib/db.ts` (Cloudflare Workers), `lib/billing.ts` (error names only, bounded
   send), `credits.ts` (amount check), and for the unlock starter the `unlock_grants` table (one row per payment) with
   its `lib/fulfilment.ts` and `lib/policy.ts`. Move existing rows: `INSERT INTO unlock_grants (transaction_id,
   user_id, unlocked_at) SELECT transaction_id, user_id, unlocked_at FROM user_unlocks ON CONFLICT DO NOTHING`.

## 0.9.1 (from 0.9.0)

Nothing to run. If you copied the unlock or credits starter: send the outbox right after the payment (`lib/outbox.ts`
and `onTransaction` in its `lib/billing.ts`) and move the outbox cron to hourly (`"0 * * * *"`). A cron more often than
hourly can exhaust a free-tier database (README "Free-tier databases").

## 0.9.0 (from 0.8.7)

1. **postgres-js apps:** nothing to run. An app that wraps its client with drizzle was never affected (QR-Lab and Slop
   Remover: every row checked fine). Without drizzle, rows the kit wrote before are read correctly and rewritten on their
   next webhook or recovery run. To check: `SELECT count(*) FROM paddle_subscriptions WHERE jsonb_typeof(price_ids) = 'string'`.
2. Optional: replace `{ query: (t, p) => … }` wrappers with `paddle-kit/db` (`fromPostgresJs(sql)` etc.).
3. One-time sales with the outbox: add the outbox route (`createOutboxRoute`) on its own cron, and
   `reviews: reviewsCheck(query)` to `healthChecks`.

## 0.8.7 (from 0.8.6)

1. Run migration `006_recovery_progress` (CREATE-only; Postgres and SQLite). Readiness reports it missing until then.
2. `importFulfilment` of a **revoked** payment now needs `adjustmentId`: the Paddle adjustment that revoked it
   (`GET /adjustments?transaction_id=…`). Already-imported rows (`import:<id>`) are not migrated: if one of those orders
   may still be reversed, update its `paddle_fulfilment_adjustments.adjustment_id` to the real id by hand.
3. `drainOutbox` results have a new `lost` count, and each claim counts as an attempt (an item that keeps outliving its
   lease now stops at `maxAttempts`). Make outbox handlers idempotent on `item.id`.
4. `defineProducts` now refuses a price shared by two products (sold or retired): give each price one product.
5. If you call `reconcile` yourself with the new `since`, the key needs `notification.read` (recovery already did).

## 0.8.6 (from 0.8.5)

1. Run migration `005_fulfilment_outbox` (CREATE-only; Postgres). Harmless if you do not use `paddle-kit/fulfil`.
2. Optional: replace hand-written credit or unlock hooks with `createFulfilment` (README "Fulfilment module"). Existing
   orders kept by the hand-written example are not moved; keep the old hooks for them or migrate by hand.
3. With the module: `readiness: { fulfilment: true }`, `outboxCheck(query)` in `healthChecks`, and
   `createRecoveryRoute({ drainOutbox })`.

## 0.8.5 (from 0.8.4)

No migration. Install `#v0.8.5`. With `openTransaction`, pass the signed-in user's email: `openTransaction(id, { email })`.

## 0.8.4 (from 0.8.3)

No migration. Install `#v0.8.4`; nothing else to do. Optional: create checkouts on the server (`createCheckoutTransaction` +
`openTransaction`) instead of `open({ userId, items })`, and build portal links with `customerPortalSession`.

## 0.8.3 (from 0.8.2)

No migration. Install `#v0.8.3`; nothing else to do. Optional: replace a hand-built `entitlements` map with `products: { pro: { features: ['pro'] } }` and
open checkout with `products.checkoutPriceId(...)`. When you replace a price, move the old id to `retiredPriceIds`.

## 0.8.2 (from 0.8.1)

No migration. Install `#v0.8.2`. Nothing else to do. Optional: add `readiness: { cronSecret: process.env.CRON_SECRET }` to `billingFromEnv` (add
`permissions: ['subscription.write']` if the app changes plans through the API), so health shows a missing permission,
migration or cron secret. It makes one request to Paddle per 10 minutes of health checks.

## 0.8.1 (from 0.8.0)

No `paddle_*` migration. Install `#v0.8.1`: the Quickstart imports `priceIds` and `createRecoveryRoute`, which 0.8.0 does not have. Only if you copied these README examples:

1. **Entitlements from `PADDLE_PRICES`:** replace `Object.values(c.prices.pro as Record<string, string>)` with
   `priceIds(c.prices.pro)` (from `paddle-kit/config`), and `config.prices.x as string` with `priceIdOf(config.prices, 'x')`.
2. **Recovery route:** replace the hand-written handler with
   `export const { GET } = createRecoveryRoute({ billing, problems, apiKey: config?.apiKey, cronSecret: process.env.CRON_SECRET })`.
   A misconfigured app now answers 500, so the cron log shows it.
3. **Credit packs:** add the columns and the new `settle` from the README Example:
   `ALTER TABLE orders ADD COLUMN revoked boolean NOT NULL DEFAULT false, ADD COLUMN taken int NOT NULL DEFAULT 0;`
   An order revoked under the old example has `granted = 0` and gives back the full pack on a reversal; check those by hand.
4. **Tables:** make sure each app and each environment has its own `paddle_*` tables.

## 0.8.0 (from v0.6/v0.7 or 0.8.0-qr.1)

1. **Run migrations `003_recovery` and `004_claim_tokens_owned_ids` before deploying.** Both only create tables. Code
   of this version on a database without `004` answers 500 `store_error` to every event (Paddle retries).
2. **Claims move to `paddle_event_leases`.** During a rolling deploy an old and a new instance do not see each other's
   claims, so one event delivered to both at the same moment can run its hook twice. Hooks are at least once anyway;
   deploy outside a payment burst if that matters. Drop `paddle_event_claims` later by hand if you like.
3. **Credit packs and refunds:** compare your hooks with the README Example. If you count revoke/restore rows per event
   (the v0.7 example), switch to keeping adjustments per transaction and deriving the grant (`paymentRevoked`).
4. **Prices found by label (`resolvePrices`, no `PADDLE_PRICES`):** after deploying, run the recovery job once (or
   `syncOwnership`). Until it has stored the app's ids, webhooks answer 503 `prices_unavailable` and Paddle retries; no
   event is acked as `not_ours`. `PADDLE_API_KEY` needs `price.read` and `product.read` too.
5. **Schedule the recovery job** (README, Quickstart). Health now has `recovery`, and the doctor is red until the job
   has completed once and while it has not completed for 26 h.
6. `billingFromEnv` now uses a resilient transport by default. A custom `Store`: implement `claimToken` in
   `recordEvent` / `markEvent` and `addOwnedIds` / `getOwnedIds` to get the fixes (all optional; without them the v0.7
   behaviour stays). Code that compared `PaymentCounts` exactly gains an `invalid` field.

## 0.8.0-qr.1 candidate

Run every adapter migration, including **003_recovery**, before using `recoverBilling` or a health check that reads recovery
state. Use one shared `createPaddleTransport` instance for outbound calls and pass its `fetch` into price/recovery APIs.
Keep the verified webhook path independent of Paddle API availability. Schedule `recoverBilling` from an authenticated
cron (45-second runner, at least a 60-second host budget); return non-success on `status: 'failed'`.

`RecoveryStore` is optional on custom `Store` implementations; built-in adapters implement it. Custom stores should also
implement `applySubscription` atomically. The built-in provider path now ignores stale snapshots when calculating grace.
It does not backdate a later delinquency from an older event. Unsigned request statistics remain per instance, and the
outbound circuit is also per instance; neither is a distributed availability measurement.

Use one exact candidate tarball across consumers; swap to an immutable release tag only after release. QR Lab is being
verified first. Existing v0.7 integration branches in other apps do not automatically use these features.


paddle-kit ships as git tags (`github:SnaxxTech/paddle-kit#vX.Y.Z`). Every upgrade is the same three steps, in this order.

## 1. Read the CHANGELOG first

Open [CHANGELOG.md](CHANGELOG.md) and read every entry between your tag and the new one. Look for:

- **Behaviour change** lines: an event that used to be `ignored` and is now `processed`, a new HTTP status, a reason code that moved.
- **New migrations**: a new entry in `MIGRATIONS` / `SQLITE_MIGRATIONS`.
- **New `ReasonCode` members**: they break an exhaustive `switch` that ends in a `never` check. Add the case.

## 2. Run the new migrations, before deploying the new code

Migrations are additive (`CREATE ... IF NOT EXISTS` on `paddle_*` tables) and never edited once shipped, so running them on the old code is harmless. Running new code on a database without them is not: the webhook answers 500 `store_error` until they exist (Paddle retries, so nothing is lost, but health turns red).

- Postgres: execute every `MIGRATIONS[i].sql` from `paddle-kit/postgres` (re-running old ones is a no-op), or copy each new entry verbatim into a new migration of your own tool.
- SQLite: execute every `SQLITE_MIGRATIONS[i].sql` from `paddle-kit/sqlite` at startup.

Check first that your database has no tables of the new names with a different shape: `IF NOT EXISTS` would silently keep yours.

## 3. Bump the tag

```bash
npm i github:SnaxxTech/paddle-kit#v0.8.6
```

Commit the `package.json` and lockfile change. Since v0.5.0 the repository is public, so CI needs no token (README checklist, step 7). Then run the app's own tests and its sandbox end-to-end check.

## Per-version notes

### 0.6.x → 0.7.0

No migration. Steps 1–3 are for every app; 4–7 are optional.

1. **Live destination: run the catalog CLI once more (each app that has a live destination).** 0.6.x made live destinations with `traffic_source: "all"`, so they also accepted simulated events, signed with the real secret. `npx paddle-kit-catalog --live --env-file <live env file> --webhook-url https://<host>/api/paddle` moves the destination to `"platform"` (one PATCH; the secret stays). A destination you made by hand: set its traffic to *Platform* (real events only) in the live dashboard (Developer tools > Notifications). Sandbox destinations stay `"all"`, so the simulator keeps working.
2. **Monitors and drills that read a wrong secret from the store.** A request refused before the signature check (no body, too large, bad or missing signature, a timestamp out of the window) is no longer written to the store: `lastFailureReason`, `lastFailureAt` and `failedLast24h` no longer show `signature_mismatch`, `bad_signature_header`, `missing_body`, `body_too_large` or `stale_timestamp`. They are in health under `unverified` (memory of the instance that answers; resets on restart). Alert on an old `lastEventAt` instead (`paddle-kit-doctor --stale-hours <h>`, or `staleHours` in an apps file). The wrong-secret drill in the README checklist says what to look for now.
3. **New `ReasonCode` members: `future_timestamp` and `prices_unavailable`** (and `PriceErrorCode` `ambiguous`). Add the cases to any exhaustive `switch` that ends in a `never` check. A server clock more than 60 s behind Paddle now refuses events with 401 `future_timestamp`: check NTP, or raise `clockSkewSeconds`.
4. **`onError`.** Pass `onError: (error, ctx) => …` to `createBilling` and send the error to your error tracker, not to a public log (a driver error can carry a connection string). Optional: `hookTimeoutMs` (below 5000) and `storeTimeoutMs`.
5. **App checks in health (D).** Add `healthChecks: { price: async () => ({ ok, detail }) }` for what only the app knows, for example where its displayed price came from (`"paddle"` or `"fallback: <reason>"`; README, Find prices by their label). A failed check turns `paddle-kit-doctor` red.
6. **Prices found by label (C), for an app that wants no price ids in its env.** Today a one-time-purchase app (LeakScan); subscription apps keep `PADDLE_PRICES`, because `entitlements` needs the ids when `createBilling` is built. An app with its own `owns` function keeps it: `owns: { resolve: async () => myOwns(await idsFrom(config.resolvePrices())) }` (README, Find prices by their label).
   1. Make sure the prices were made by `paddle-kit-catalog` (each has the `paddle_kit_price` label) and that each label has exactly one active price. `findPriceMap('<app>', { apiKey, environment })` shows what the kit will find.
   2. `readBillingEnv(process.env, { requiredPrices: [...], resolvePrices: { app: '<catalog app>' } })`. Keep `owns: config.owns` as it is: it becomes a resolver, and a failed lookup answers 503 so Paddle retries.
   3. Read ids with `await config.resolvePrices()` (in hooks, in the checkout page), never from `config.prices` (it is `{}` without `PADDLE_PRICES`). Show the price with `findPrice` instead of `getPrice`.
   4. Put `PADDLE_API_KEY` on the host. Deploy, check with `paddle-kit-doctor`, send a sandbox checkout, and only then remove `PADDLE_PRICES` from the host (while it is set, it wins).
7. **Rotate the webhook secret without downtime** when needed: `PADDLE_NOTIFICATION_WEBHOOK_SECRET=old,new` and `webhookSecret: config.webhookSecrets ?? config.webhookSecret` (README, Monitoring).
8. **Chargebacks and reversals.** Handle every adjustment through `adjustmentEffect(adj)` (README, Refunds, chargebacks and reversals): `revoke`, `restore` (only what you revoked for that transaction), `review`, `none`. Before, the README example acted on approved refunds only, so a chargeback kept access and a won dispute never gave it back.
9. **Reconcile payments.** Call `reconcilePayments(billing, { apiKey, since: <7 days ago> })` from the cron that runs `reconcile`. It needs `PADDLE_API_KEY`; your hooks must be idempotent (they already must be).
10. **Optional: `billingFromEnv`** replaces the `readBillingEnv` + `createBilling` pair (README, Quickstart).
11. **Watch every app:** list the apps in an `apps.json` (`name`, `url`, `tokenEnv`, `staleHours`) and run `paddle-kit-doctor --apps apps.json --json` on a schedule; exit 2 means the file is wrong, not that the apps are fine.

A custom `Store` needs no change. `Health` is unchanged; the route adds `unverified` (and `checks`).

### 0.5.0 → 0.6.0

Nothing breaks; every step is optional.

1. **Route file.** Replace the hand-written null-safe route with `export const { POST, GET } = createWebhookRoute({ billing, problems, healthToken: process.env.PADDLE_HEALTH_TOKEN })` from `paddle-kit/next`. The statuses stay the same (404 off, 503 misconfigured). New: a GET says `billing_off` / `health_off`, and with the health token the 503 lists the problem names, for `paddle-kit-doctor`. A monitor that checks for an empty 404 or 503 body must accept the JSON body on GET.
2. **Price in Paddle only.** Read the price with `getPrice` + `formatPrice` (`paddle-kit/price`), cached in the app, with your old constant as the fallback (README, "Show the price from Paddle"). Then delete the price from the app's code. It needs `PADDLE_API_KEY` on the host. A changed amount keeps its price id, so `PADDLE_PRICES` does not change.
3. **Check each deployment** with `npx paddle-kit-doctor --url https://<host>/api/paddle` (token in `PADDLE_HEALTH_TOKEN`).
4. **Host variables.** The next `paddle-kit-catalog` run prints the block for the host. Compare it with the host's settings; anything only in `.env.local` is missing in the deployed app.

### 0.4.x → 0.5.0

1. **No token to install.** The repository is public. Delete the `PADDLE_KIT_READ_TOKEN` secret and the `git config ... insteadOf` step from CI. A lockfile with a `git+ssh://` URL still installs with no SSH key (README checklist, step 7).
2. **API version pinned to 1.** The REST calls of `reconcile` and the catalog CLI send `Paddle-Version: 1`. The next catalog sync with `--webhook-url` sets `api_version: 1` on an existing destination (one PATCH). A destination you manage by hand: check that its API version is 1 in the Paddle dashboard. Payloads of version 1 are what the kit reads. Paddle refuses a version older than the account's default: if your account's default is newer than 1, the calls fail on purpose until the kit supports that version.
3. **Health has two more fields:** `kitVersion` and `environment`. A monitor that compares the whole JSON must accept them.
4. **`paddle_customers` is no longer written.** Rows written before 0.5.0 stay, and on a shared seller account they include other apps' customer emails. Deleting them (`DELETE FROM paddle_customers;`) is the owner's decision, per app: the kit never reads the table, so the delete changes nothing for the kit. Keep the table: migration `001_init` still creates it.
5. **Catalog sync** now subscribes the destination to 13 events (no `customer.*`). The next sync of an existing destination updates it. A destination you manage by hand: unsubscribe `customer.created` and `customer.updated` in the Paddle dashboard; if you leave them, they are acked as `ignored`.
6. A custom `Store` still compiles: `upsertCustomer` stays in the interface (deprecated) until 0.6.0. The kit no longer calls it.

### 0.3.x → 0.4.0

1. **Migration `002_claims_transactions`** adds `paddle_event_claims` and `paddle_transactions`. Run it before deploying 0.4.0.
2. **Shared seller account?** (Every SnaxxTech app is on one.) Pass `owns: config.owns` from `readBillingEnv` to `createBilling`, then **delete the app's hand-written "not our product" filter** in `onTransaction`. Keep anything the filter did beyond ownership, such as checking the order marker in `customData`.
3. **`onAdjustment` gets `ctx.known`.** `false` = the kit never saw the transaction as yours: the payment may arrive later. Record such a refund; never return early on it. Transactions received before 0.4.0 were never recorded, so their refunds arrive with `known: false` too.
4. **409 `in_progress`.** A duplicate delivery that arrives while the first one is still running its hooks now answers 409 instead of running the hooks a second time. Paddle retries it, and the retry is a 200 duplicate. Dashboards that alert on any non-2xx from Paddle will see these; they are not failures.
5. `reconcile()` returns `{ scanned, applied, notOurs, invalid }`. A strict equality check on the old shape needs the new fields.
6. `ReasonCode` gained `not_ours` and lost `missing_raw_body`.

**Removed in 0.4.0 — one line each, with the replacement** (neither Offday nor AppCare used any of them):

| Removed | Use instead |
|---|---|
| `paddle-kit/hono` (`paddleWebhook`, `paddleHealth`) | `app.post(path, (c) => billing.handleWebhook(c.req.raw))`, the same with `handleHealth` (README, Other frameworks) |
| `paddle-kit/express` | `express.raw({ type: '*/*' })` plus a `Request` built from the raw body (README, Other frameworks) |
| `Billing.recordFailure`, `Billing.log`, reason `missing_raw_body` | nothing: they existed only for the Express adapter |
| `reconcile(billing, { apiKey, client })` (Paddle Node SDK) | `reconcile(billing, { apiKey, fetch? })`; drop `@paddle/paddle-node-sdk` unless you use it yourself |
| `SdkSubscriptionLike`, `fromSdkSubscription` | none needed: reconcile maps the API's snake_case entity itself |
| `itemsOf`, `customDataOf` from `paddle-kit/core` | read `sub.raw.items` / `sub.raw.custom_data` (the raw Paddle entity, snake_case) |
| `verifySignature`, `VerifyResult`, `decideAccess`, `AccessPolicy` | `billing.handleWebhook` / `billing.hasAccess` |
| `billing.getSubscriptions(userId)` | `billing.store.getSubscriptionsByUser(userId)` |
| `billing.health()` | `billing.store.health(new Date())` |
| `createBilling({ signatureToleranceSeconds })` | nothing: fixed at 5 s |
| `checkout.open({ priceId, quantity })` | `checkout.open({ items: [{ priceId, quantity }] })` |
| `checkout.open({ successUrl })` | handle Paddle.js `checkout.completed` in `createCheckout({ onEvent })` and navigate |
| `node_modules/paddle-kit/migrations/*.sql` | `MIGRATIONS` from `paddle-kit/postgres` |
| the `"import"` export condition | nothing: `"default"` resolves the same files for ESM and CJS-style resolvers |
