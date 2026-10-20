# Upgrading paddle-kit

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
npm i github:SnaxxTech/paddle-kit#v0.5.0
```

Commit the `package.json` and lockfile change. Since v0.5.0 the repository is public, so CI needs no token (README checklist, step 4). Then run the app's own tests and its sandbox end-to-end check.

## Per-version notes

### 0.4.x → 0.5.0

1. **No token to install.** The repository is public. Delete the `PADDLE_KIT_READ_TOKEN` secret and the `git config ... insteadOf` step from CI, and commit a lockfile with a `git+https` URL for the kit (README checklist, step 4).
2. **API version pinned to 1.** The REST calls of `reconcile` and the catalog CLI send `Paddle-Version: 1`. The next catalog sync with `--webhook-url` sets `api_version: 1` on an existing destination (one PATCH). A destination you manage by hand: check that its API version is 1 in the Paddle dashboard. Payloads of version 1 are what the kit reads.
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
