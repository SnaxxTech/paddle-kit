# Changelog

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
- `createBilling({ owns })` and `reconcile` accept an `OwnsResolver` (`{ resolve(): Promise<OwnedIds> }`), awaited per event. A lookup that throws, times out (`hookTimeoutMs`) or finds no id answers **503 `prices_unavailable`** and marks the event `failed`, so Paddle retries; nothing is ever marked `not_ours` (or mirrored as "owns everything") because a lookup failed. `reconcile` throws before reading any subscription.

### Monitoring (D, E)
- `createBilling({ healthChecks: { [name]: () => Promise<{ ok, detail? }> }, healthCheckTimeoutMs? })`: app checks on the authenticated health route, in parallel, each with a timeout (default 3000 ms). A throw, a timeout or a non-result is `{ ok: false }`; the error goes to `onError`, never into the report. Shown as `checks` in health. New exported types `HealthReport`, `CheckResult`, `UnverifiedStats`, `ErrorContext`, `OwnsResolver`.
- `paddle-kit-doctor --apps apps.json [--json]`: the file lists `{ name, url, tokenEnv, staleHours? }`; each token comes from the variable `tokenEnv` names (an entry with `token` is refused). A table (reachable, env, last verified event and its age against `staleHours`, failures in 24 h with the last reason, app checks) or one JSON result per app for a scheduled job. Exit 0 all green, 1 any app red, 2 a bad file or flags (nothing checked). Single-app mode is unchanged and gains `--stale-hours` and `--json`. It shows the `unverified` counts (a `signature_mismatch` among them is a warning) and app checks, and treats a recent `prices_unavailable` as a problem. Never prints a token.

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
