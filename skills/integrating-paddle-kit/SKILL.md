---
name: integrating-paddle-kit
description: Use when adding Paddle billing, subscriptions, one-time purchases, refunds, trials or paywalls to a SnaxxTech web app, or when a project mentions Paddle, checkout, pricing enforcement or paddle-kit
---

# Integrating paddle-kit

## Overview
`paddle-kit` (public repo `SnaxxTech/paddle-kit`, install `github:SnaxxTech/paddle-kit#vX.Y.Z`) already does webhook verification, the idempotent event ledger, the subscription mirror, `hasAccess`, plan state, env validation, checkout and the sandbox catalog. An integration is **wiring, not writing**: never re-implement signature checks, ledgers, catalog scripts or env parsing in the app. Read the kit's README for exact APIs; this skill is the order of work and the traps.

## Decide first (write the answers in the PR)
Read the target app before deciding: confirm its roles, auth, DB driver, existing crons and middleware in the code — never assume them. Mark anything you could not confirm as an open question.

| Decision | Rule |
|---|---|
| Billed subject | The account that pays (team/org/workspace id), sent as checkout `userId`. Never a person if seats are shared. |
| Model | Subscription → `hasAccess` + `paddle-kit/plan`. One-time (orders, packs) → `onTransaction` hook. Refunds → `onAdjustment`. |
| Free period | `planOf` with `startedAt = max(createdAt, BILLING_LAUNCH_AT)` so **existing** accounts are not locked out on launch day. |
| Enforcement | One server choke point per paid action, `402` + message, behind `BILLING_ENFORCE=1` (default off). Reads never blocked. |
| Allowlist | Expired accounts keep: sign-in/out, password recovery, profile, and everything a manager needs to **pay**. |

## Build order
1. **Pricing source of truth** → `paddle.catalog.json` generated from (or checked against) the app's pricing constants; add a test that catalog totals equal the published prices.
2. **Store**: Postgres/Neon → `postgresStore({ query })` + kit `MIGRATIONS`; SQLite → `sqliteStore({ db })` + `SQLITE_MIGRATIONS`. Additive `paddle_*` tables only; run **every** entry (001, 002, …) the way the app runs its own migrations, and before deploying the code that needs them.
3. **Env**: `readBillingEnv(process.env, { requiredPrices, requiredCycles?, requireLaunchAt? })` from `paddle-kit/config`. Construct `createBilling` **only when `config` is non-null**; log `problems` (names only). Pass `onError` and send the error to the app's error tracker (it can carry secrets: never a public log). Pass `owns: config.owns` (every price id in `PADDLE_PRICES`): the SnaxxTech seller account is **shared by several apps**, and every app's webhook receives every product's events. Never construct at import with a possibly-missing secret — CI `next build` and preview deploys run without secrets.
4. **Webhook route**, null-safe (404 off, 503 misconfigured; since v0.6.0):
   ```ts
   // app/api/paddle/route.ts
   import { createWebhookRoute } from 'paddle-kit/next';
   export const { POST, GET } = createWebhookRoute({ billing, problems, healthToken: process.env.PADDLE_HEALTH_TOKEN });
   ```
   Not Next.js, same null checks by hand: pass the framework's raw Web `Request` (Hono `c.req.raw`); Express needs `express.raw()` and a `Request` built from the raw body. There are no Hono/Express adapters since v0.4.0. Missed webhooks: `reconcile(billing, { apiKey })` from an existing cron (fetch-based, no Paddle SDK).
5. **Hooks (one-time/refunds)**: `onTransaction` runs on `transaction.completed` (also renewals → filter `subscriptionId === null`), **at least once, possibly more** (retries, timeouts, taken-over claims): write order + grant in ONE DB transaction keyed on `transactionId`. `customData` is untrusted — match `tx.items` priceId and grant by quantity; never equality-check amounts (discounts, tax, local currency). Unknown price → persist a review row, don't drop silently. Other products' transactions never reach the hook when `owns` is set (they are ledger rows `ignored` / `not_ours`); don't hand-write that filter in the app. `onAdjustment`: act on `status === 'approved'` and `type === 'full'`; partial → review. **`ctx.known === false`** means the kit never saw the transaction as yours (a refund can arrive before its payment, or the payment predates v0.4.0): record it (e.g. a resolved `refund_unmatched` row the payment path checks) — never return early on it.
6. **UI**: checkout via `paddle-kit/client` (`items`, `userId`, extra `customData`); poll the app's own state after `checkout.completed` — the webhook, not the browser, grants access.
7. **Price**: never hard-code the price in the app. Read it with `findPrice({ app, key, cycle })` (by the catalog label, since v0.7.0) or `getPrice(id)`, plus `formatPrice` (`paddle-kit/price`), cached by the app (Next.js 16: `"use cache"` + `cacheLife('hours')`), with the old constant as fallback outside the cached function. Report the source in health: `healthChecks: { price: … ({ ok: source === 'paddle', detail: source }) }` (`"paddle"` or `"fallback: <code>"`). A **one-time-purchase** app may drop `PADDLE_PRICES`: `readBillingEnv(…, { resolvePrices: { app } })`, ids from `await config.resolvePrices()`, `owns: config.owns` unchanged (a resolver: a failed lookup answers 503 `prices_unavailable`, never `not_ours`). Subscription apps keep `PADDLE_PRICES` (`entitlements` needs ids at construction). LeakScan showed the built-in price for hours because its configured id was not the price the owner edited.
8. **Host env**: paste the block that `paddle-kit-catalog` prints into the host (`--host vercel` prints the commands); a variable only in `.env.local` is missing in production (LeakScan shipped with checkout off this way). Then `npx paddle-kit-doctor --url https://<host>/api/paddle --stale-hours <h>` (token in `PADDLE_HEALTH_TOKEN`) must end `Result: OK` in every environment that takes payments. Add the app to the scheduled `paddle-kit-doctor --apps apps.json --json` file (`{ name, url, tokenEnv, staleHours }`, never a token).
9. **CI and the deploy host** install the kit with no token (public since v0.5.0). Secrets never go in the kit: each app keeps its Paddle key, webhook secret and client token in its own env files and host settings. A `git+ssh://` lockfile URL is fine: npm downloads public GitHub dependencies as a tarball, with no SSH key.

## Sandbox end-to-end (required before any PR is "done")
1. `cloudflared tunnel --url http://localhost:<port>` (quick tunnels die — on "Tunnel not found", restart and re-run the catalog CLI to re-point).
2. Run the catalog CLI. In **sandbox** it sets `traffic_source: all` on the destination, which the simulator needs (Paddle's default, `platform`, rejects simulations). In **live** it sets `platform`, real events only, and moves an existing live destination there: a live app must never accept simulated events, which are signed with the real secret.
   `npx paddle-kit-catalog --catalog paddle.catalog.json --webhook-url https://<tunnel>/api/paddle` (the **full** endpoint URL) → prices, destination, client token, `.env.local` (0600). Live: separate `--env-file` + `--live`.
3. **Owner/dashboard:** Paddle > Checkout > Checkout configuration → **Default payment link** = a public https URL (localhost is rejected). Without it checkout fails with `transaction_default_checkout_url_not_set`. Repeat in the **live** dashboard before launch.
4. Real checkout in the browser with test card `4242 4242 4242 4242`; verify webhook rows `processed`, subject linked, app state flipped. Cancel with `effective_from: "immediately"` (a period-end cancel stays `active` until renewal) and verify it flips back; wrong-secret drill → 401 in Paddle's delivery log, `unverified.byReason.signature_mismatch` in health on the instance that answered (refusals before the signature check are kept in memory only since v0.7.0, never in the DB), and `lastEventAt` stops moving (`paddle-kit-doctor --stale-hours` turns red). Expiry drill: set `BILLING_LAUNCH_AT` (and the account's start) more than `trialDays` in the past, **restart** (env is read at boot), confirm 402 on the paid action and that reads/sign-in/pay still work.

| Environment | API key | Client token | `PADDLE_ENV` | env file |
|---|---|---|---|---|
| Sandbox | `pdl_sdbx_…` | `test_…` | `sandbox` | `.env.local` |
| Live | `pdl_live_…` | `live_…` | `production` | separate (`--env-file`, `--live`) |

## Common mistakes
| Mistake | Consequence |
|---|---|
| Trial = `createdAt + N days` | Every existing account goes read-only at launch |
| `createBilling` at module load | CI/preview build crashes without secrets |
| `insteadOf` only for https | `npm ci` still fails on the `git+ssh` lock entry |
| Granting on `transaction.paid` and `.completed` | Double fulfilment — the kit hooks `.completed` only |
| Trusting `custom_data.order_id` / comparing amounts | Forged orders; discounted/taxed/converted buyers rejected |
| Insert order, then grant in a separate step | A retry after a failed grant never grants |
| Blocking password recovery when expired | Users locked out of a read-only account |
| Hand-typed dashboard prices | Prices drift from the landing page |
| Hand-written "not our product" filter instead of `owns` | Dropped real refunds once (AppCare): a refund of an unseen payment looked foreign |
| Returning early on `onAdjustment` with `ctx.known === false` | A refund that beat its payment is lost; the payment is then granted |
| `npx paddle-kit-catalog` outside the app | npm E404: the kit is not on the registry. Run it in the app after install, or `npx --package=github:SnaxxTech/paddle-kit#vX.Y.Z paddle-kit-catalog` |
| Env only in `.env.local` | The deployed app has billing off or misconfigured; `paddle-kit-doctor` shows it |
| Treating 409 `in_progress` as an outage | It is a concurrent duplicate; Paddle's retry of it is a 200 duplicate |
| A live destination with `traffic_source: all` (made by kit ≤0.6 or by hand) | Simulated events, signed with the real secret, reach the live app. Re-run the catalog CLI with `--live`, or set *Platform* in the dashboard |
| Alerting on `unverified` or `failedLast24h` for a wrong secret | Bots send bad signatures too, and `unverified` is per instance. Alert on an old `lastEventAt` (`staleHours`) |
| Reading `config.prices` with `resolvePrices` on | It is `{}` without `PADDLE_PRICES`: use `await config.resolvePrices()` |

## Monitoring
Health route with `PADDLE_HEALTH_TOKEN`; the owner signal is a stale `lastEventAt` (no verified webhook for longer than normal traffic allows). Every SnaxxTech app goes into the scheduled multi-app doctor (`paddle-kit-doctor --apps apps.json --json`: exit 1 = an app is red, exit 2 = the file is wrong) with a `staleHours` that fits its traffic; app-only facts go in `healthChecks`. Paddle retries live up to 60 times in about two days, sandbox 3 times within about two minutes: state the worst-case delay of the alert in the PR.

## Hand-off (always list)
Dashboard default payment link (sandbox + live), webhook secret per environment, key rotation, live domain approval, `BILLING_LAUNCH_AT` choice, and what was **not** verified (real renewals, refunds in live).
