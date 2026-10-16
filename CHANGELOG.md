# Changelog

## 0.4.0 (unreleased)

Upgrade steps: [UPGRADING.md](UPGRADING.md). **Run migration `002_claims_transactions` before deploying.**

### Shared seller accounts
- New `createBilling({ owns })`: `{ priceIds?, productIds? }` or a predicate `({ kind, items, customData }) => boolean`. Subscription and transaction events with none of them are acknowledged and recorded as `ignored` with the new reason `not_ours`: never mirrored, no hook, not a failure in health, no warn line. A subscription already in the mirror stays ours; so does a transaction on a mirrored subscription. An `owns` object without ids throws; a throwing predicate fails the event as `hook_error`.
- Every transaction seen is remembered with its ownership (new table `paddle_transactions`; optional `Store.recordTransaction` / `getTransaction`, implemented by all three kit stores). An adjustment of a transaction seen as someone else's is `not_ours`. An adjustment of a transaction never seen is **not dropped**: `onAdjustment` gets it with the new `ctx.known === false` (a refund can arrive before its payment).
- `readBillingEnv` returns `config.owns = { priceIds }` with every id in `PADDLE_PRICES` (absent for an empty map).
- `reconcile` mirrors only our subscriptions (or ones already mirrored) and returns `{ scanned, applied, notOurs }`.

### Idempotency under concurrency
- Behaviour change: duplicate deliveries of an event that arrive while another delivery is running its hooks answer **409 `{ "error": "in_progress" }`** instead of running the hooks again (50 parallel deliveries ran `onTransaction` 50 times in 0.3.1). Claims live in the new table `paddle_event_claims`, so the ledger row keeps its `failed` status and `received_at` during a retry. A failed attempt releases its claim at once; a claim older than the new `eventLeaseSeconds` (default 60) is taken over as a crashed attempt. `Store.recordEvent` takes an optional `leaseExpiredBefore` and may return `inProgress`; a custom store that ignores both keeps the 0.3 at-least-once behaviour.
- New real-Postgres suite `npm run test:pg` (N=50 parallel duplicates, shuffled parallel `subscription.updated`, flaky-hook redeliveries, 1,000-event load with p95 and a sample-count reconciliation). It skips with a loud SKIP line when no server is available, and fails in CI (`PADDLE_KIT_REQUIRE_PG=1`) instead of skipping.

### Tooling
- `UPGRADING.md`; CI workflow (`.github/workflows/ci.yml`): typecheck, tests, build, edge check, the packed-tarball smoke check in a scratch app, and the Postgres suite against a `postgres:16` service.
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
