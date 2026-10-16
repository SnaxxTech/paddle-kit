---
name: integrating-paddle-kit
description: Use when adding Paddle billing, subscriptions, one-time purchases, refunds, trials or paywalls to a SnaxxTech web app, or when a project mentions Paddle, checkout, pricing enforcement or paddle-kit
---

# Integrating paddle-kit

## Overview
`paddle-kit` (private repo `SnaxxTech/paddle-kit`, install `github:SnaxxTech/paddle-kit#vX.Y.Z`) already does webhook verification, the idempotent event ledger, the subscription mirror, `hasAccess`, plan state, env validation, checkout and the sandbox catalog. An integration is **wiring, not writing**: never re-implement signature checks, ledgers, catalog scripts or env parsing in the app. Read the kit's README for exact APIs; this skill is the order of work and the traps.

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
3. **Env**: `readBillingEnv(process.env, { requiredPrices, requiredCycles?, requireLaunchAt? })` from `paddle-kit/config`. Construct `createBilling` **only when `config` is non-null**; log `problems` (names only). Pass `owns: config.owns` (every price id in `PADDLE_PRICES`): the SnaxxTech seller account is **shared by several apps**, and every app's webhook receives every product's events. Never construct at import with a possibly-missing secret — CI `next build` and preview deploys run without secrets.
4. **Webhook route**, null-safe:
   ```ts
   // app/api/paddle/route.ts
   const off = () => new Response(null, { status: problems.length ? 503 : 404 });
   export const POST = (r: Request) => (billing ? billing.handleWebhook(r) : off());
   export const GET  = (r: Request) => (billing ? billing.handleHealth(r)  : off()); // PADDLE_HEALTH_TOKEN
   ```
5. **Hooks (one-time/refunds)**: `onTransaction` runs on `transaction.completed` (also renewals → filter `subscriptionId === null`), **at least once**: write order + grant in ONE DB transaction keyed on `transactionId`. `customData` is untrusted — match `tx.items` priceId and grant by quantity; never equality-check amounts (discounts, tax, local currency). Unknown price → persist a review row, don't drop silently. Other products' transactions never reach the hook when `owns` is set (they are ledger rows `ignored` / `not_ours`); don't hand-write that filter in the app. `onAdjustment`: act on `status === 'approved'` and `type === 'full'`; partial → review. **`ctx.known === false`** means the kit never saw the transaction as yours (a refund can arrive before its payment, or the payment predates v0.4.0): record it (e.g. a resolved `refund_unmatched` row the payment path checks) — never return early on it.
6. **UI**: checkout via `paddle-kit/client` (`items`, `userId`, extra `customData`); poll the app's own state after `checkout.completed` — the webhook, not the browser, grants access.
7. **CI and the deploy host** both install the private dependency. Actions recipe below; the host (e.g. Vercel) also needs access — its mechanism is host-specific and UNVERIFIED here: confirm it in the host's docs and say so in the PR. For CI: secret `PADDLE_KIT_READ_TOKEN` (fine-grained, read-only Contents on `SnaxxTech/paddle-kit`) + `git config --global url."https://x-access-token:${TOKEN}@github.com/".insteadOf` for **`ssh://git@github.com/`, `git@github.com:` and `https://github.com/`** (npm locks `git+ssh`). Verify the secret exists: `gh api repos/<owner>/<repo>/actions/secrets` must list it.

## Sandbox end-to-end (required before any PR is "done")
1. `cloudflared tunnel --url http://localhost:<port>` (quick tunnels die — on "Tunnel not found", restart and re-run the catalog CLI to re-point).
2. Run the catalog CLI — it sets `traffic_source: all` on the destination, which the simulator needs (a hand-made destination without it rejects simulations):
   `npx paddle-kit-catalog --catalog paddle.catalog.json --webhook-url https://<tunnel>/api/paddle` (the **full** endpoint URL) → prices, destination (`traffic_source: all`), client token, `.env.local` (0600). Live: separate `--env-file` + `--live`.
3. **Owner/dashboard:** Paddle > Checkout > Checkout configuration → **Default payment link** = a public https URL (localhost is rejected). Without it checkout fails with `transaction_default_checkout_url_not_set`. Repeat in the **live** dashboard before launch.
4. Real checkout in the browser with test card `4242 4242 4242 4242`; verify webhook rows `processed`, subject linked, app state flipped. Cancel with `effective_from: "immediately"` (a period-end cancel stays `active` until renewal) and verify it flips back; wrong-secret drill → 401 + health `signature_mismatch`. Expiry drill: set `BILLING_LAUNCH_AT` (and the account's start) more than `trialDays` in the past, **restart** (env is read at boot), confirm 402 on the paid action and that reads/sign-in/pay still work.

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
| Treating 409 `in_progress` as an outage | It is a concurrent duplicate; Paddle's retry of it is a 200 duplicate |

## Monitoring
Health route with `PADDLE_HEALTH_TOKEN`; the owner signal is a stale `lastEventAt` (no webhook for longer than normal traffic allows) — wire it into an existing alert/cron if the app has one, else list it as an owner item with the worst-case delay.

## Hand-off (always list)
Dashboard default payment link (sandbox + live), webhook secret per environment, `PADDLE_KIT_READ_TOKEN`, key rotation, live domain approval, `BILLING_LAUNCH_AT` choice, and what was **not** verified (real renewals, refunds in live).
