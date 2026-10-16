# paddle-kit v0.3.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make paddle-kit the one place every SnaxxTech web app gets Paddle from — including one-time purchases and refunds (AppCare's $49 scan, QR-Lab's QR packs), quantity-aware plans, and the generic pieces Offday had to write itself (plan state, env validation, sandbox catalog sync) — without breaking v0.2 consumers.

**Why (evidence, 2026-10-16):** AppCare already sells one-time scans through a hand-rolled Paddle integration that trusts client `custom_data.order_id`, never checks price/amount, and has no refund handling, idempotency or health (survey). QR-Lab plans subscriptions plus one-time QR packs with quantity limits. Offday re-implemented plan state, env validation and a catalog script. Three unguided agents planning an integration all built CI that crashes because `createBilling` throws on a missing secret at import.

**Architecture:** additive only. New normalised event kinds `transaction` and `adjustment`; optional `onTransaction` / `onAdjustment` hooks in `createBilling`, run once per verified event after the idempotency ledger records it (a throwing hook → event `failed` → 500 → Paddle retries). New subpath exports `paddle-kit/plan`, `paddle-kit/config`, `paddle-kit/catalog` (+ a `paddle-kit-catalog` bin). No schema change: transactions/adjustments are not mirrored into new tables in v0.3 (the app owns its orders); quantities and full custom data are read from the stored subscription `raw`.

**Tech Stack:** unchanged (TypeScript 5.9.3 pinned, tsup, vitest, PGlite/better-sqlite3 in tests).

## Global Constraints

- Backward compatible: every v0.2.0 test keeps passing unchanged; no change to SQL migrations; existing exports keep their signatures.
- `src/core`, `src/plan`, `src/config` stay edge-safe (no `node:` imports, no runtime deps) — add them to `scripts/check-edge.mjs`. `src/catalog` is Node-only (uses `node:fs` for the env file) and is NOT in the edge list.
- Secrets never printed/logged; catalog CLI refuses non-`pdl_sdbx_` keys unless `--live` is passed explicitly (and then refuses `test_` client tokens).
- Real payloads first: transaction fixture already exists (`tests/fixtures/transaction.completed.json`, real sandbox capture); add `adjustment.created.json` from Paddle's docs example (`https://developer.paddle.com/webhooks/adjustments/adjustment-created.md`), recorded in SOURCES.md.
- Version 0.3.0; tag with `scripts/release.sh 0.3.0`; commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A hook that throws must not mark the event processed, and the retry must run the hook again exactly once on success (ledger semantics).
2. A duplicate delivery of a processed transaction must NOT call `onTransaction` again.
3. `transaction.completed` without hooks keeps v0.2 behaviour (processed, no state change).
4. `readBillingEnv` with nothing set returns `{ config: null, problems: [] }` (silent); partially set → problems name variables only, never values.
5. `syncCatalog` second run is a no-op; one-time prices have `billing_cycle: null`; never prints the key/secret.

---

### Task 1: Transactions, adjustments and hooks

**Files:** `src/core/events.ts`, `src/core/types.ts`, `src/core/handler.ts`, `src/core/billing.ts`, `src/core/index.ts`, `tests/events.test.ts`, `tests/handler.test.ts`, `tests/fixtures/adjustment.created.json`, `tests/fixtures/SOURCES.md`.

**Interfaces (produce exactly):**
```ts
// types.ts
export interface LineItem { priceId: string; productId: string | null; quantity: number }
export interface Transaction {
  transactionId: string; status: string; customerId: string | null; subscriptionId: string | null;
  customData: Record<string, unknown> | null; items: LineItem[];
  currency: string | null; total: string | null;           // grand total in lowest unit, as Paddle sends it (string)
  occurredAt: string; raw: unknown;
}
export interface Adjustment {
  adjustmentId: string; action: string; status: string;      // action: refund | credit | chargeback | …; status: pending_approval | approved | rejected
  transactionId: string; subscriptionId: string | null; customerId: string | null;
  currency: string | null; total: string | null; occurredAt: string; raw: unknown;
}
export interface HookContext { eventId: string; eventType: string; store: Store }
// events.ts — NormalisedEvent gains:
//   | (Envelope & { kind: 'transaction'; transaction: Transaction })   for transaction.completed and transaction.paid
//   | (Envelope & { kind: 'adjustment'; adjustment: Adjustment })      for adjustment.created and adjustment.updated
// Malformed (missing data.id / transaction_id) → null as today.
// helpers (exported from core):
export function itemsOf(sub: Subscription): LineItem[];               // from sub.raw.items (price.id, price.product_id, quantity ?? 1)
export function customDataOf(sub: Subscription): Record<string, unknown> | null;
// billing.ts BillingConfig gains:
//   onTransaction?: (tx: Transaction, ctx: HookContext) => Promise<void> | void;
//   onAdjustment?: (adj: Adjustment, ctx: HookContext) => Promise<void> | void;
```
Field sources (Paddle snake_case): transaction `data.id`, `status`, `customer_id`, `subscription_id`, `custom_data`, `items[].price.id`, `items[].price.product_id`, `items[].quantity`, `currency_code`, `details.totals.grand_total` (fallback `details.totals.total`). Adjustment `data.id`, `action`, `status`, `transaction_id`, `subscription_id`, `customer_id`, `currency_code`, `totals.total`. Confirm against the real fixture and the SDK types in `node_modules/@paddle/paddle-node-sdk/dist/types` (entities/transaction, entities/adjustment); fixtures win over this text.

Handler semantics: in `apply()`, `transaction` → if `onTransaction` set, await it; return `{status:'processed', reason:null}`. Same for `adjustment`. Hooks run after `recordEvent` (so duplicates already-done never reach them) and before `markEvent`; a throw → event `failed` with reason `hook_error` (new ReasonCode, additive) + 500; a store failure stays `store_error`. `transaction.paid` and `adjustment.*` were `ignored` in v0.2 and become `processed` (record-only when no hook) — note in README.

Tests (see each fail first): parse the real transaction fixture (items with quantity, customData, currency, total); parse the adjustment fixture; malformed → null; `itemsOf`/`customDataOf` on the subscription fixture; handler: hook called once with the parsed transaction; duplicate delivery → not called again; hook throws → 500 with the new ReasonCode `hook_error` (logged + event `failed` reason `hook_error`, visible in health); retry after fix → hook called once more and event processed; no hook → processed; adjustment hook called with refund data.

- [ ] Steps: write failing tests → implement → `npx tsc --noEmit && npx vitest run` → commit `feat(core): one-time transactions and refund hooks`.

### Task 2: Checkout custom data

**Files:** `src/client/index.ts`, `tests/client.test.ts`.
`CheckoutOptions` gains `customData?: Record<string, unknown>`; Paddle.js receives `customData: { ...o.customData, userId: o.userId }` (userId always wins, so linking can't be overridden). Test: extra keys pass through; a `userId` inside `customData` is overwritten by `o.userId`. Commit `feat(client): extra custom data on checkout`.

### Task 3: `paddle-kit/plan` and `paddle-kit/config`

**Files:** `src/plan/index.ts`, `src/config/index.ts`, `tests/plan.test.ts`, `tests/config.test.ts`, `tsup.config.ts`, `package.json` exports, `scripts/check-edge.mjs` (add `plan`, `config`), `scripts/smoke-pack.mjs` (import + NodeNext type check).

Port and generalise from Offday (`/Users/gentlegen/Desktop/Projects/offday-billing/lib/plan.ts`, `lib/billing-config.ts`, `tests/billing.spec.ts` plan/config describes — read them):
```ts
// paddle-kit/plan
export type Plan = { kind: 'free' } | { kind: 'paid' } | { kind: 'trial'; endsAt: number; daysLeft: number } | { kind: 'expired'; endedAt: number };
export function planOf(i: { exempt: boolean; startedAt: number; launchAt: number | null; trialDays: number; subscribed: boolean; now: number }): Plan;
// trialDays 0 → no trial: not subscribed ⇒ expired at max(startedAt, launchAt).
// paddle-kit/config
export type PriceMap = Record<string, string | Record<string, string>>;   // key → priceId, or key → { cycle → priceId }
export interface BillingEnv { environment: 'sandbox'|'production'; webhookSecret: string; prices: PriceMap; clientToken: string; launchAt: number | null; enforce: boolean; healthToken?: string; apiKey?: string }
export function readBillingEnv(env: Record<string, string | undefined>, opts: { requiredPrices: string[]; requireLaunchAt?: boolean }): { config: BillingEnv | null; problems: string[] };
```
Variables: `PADDLE_ENV`, `PADDLE_NOTIFICATION_WEBHOOK_SECRET`, `PADDLE_PRICES` (JSON PriceMap; every `requiredPrices` key present with non-empty ids), `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` (prefix must match env), `BILLING_LAUNCH_AT` (ISO with timezone; required only if `requireLaunchAt`), `BILLING_ENFORCE` (`1` only), `PADDLE_HEALTH_TOKEN`, `PADDLE_API_KEY` (if set, prefix must match env). Watched set = all of these except `PADDLE_HEALTH_TOKEN`/`PADDLE_API_KEY`: none set → silent null; some set and invalid → problems naming variables (never values). Tests port Offday's cases plus: problem strings never contain any planted value; PriceMap nested and flat forms. Commit `feat: generic plan state and billing env validation`.

### Task 4: `paddle-kit/catalog` + `paddle-kit-catalog` CLI

**Files:** `src/catalog/index.ts`, `src/catalog/cli.ts`, `tests/catalog.test.ts`, `tsup.config.ts` (entries for both; CLI with shebang), `package.json` (`"bin": { "paddle-kit-catalog": "./dist/catalog/cli.js" }`, export `./catalog`).

Port and generalise Offday's `scripts/paddle-sandbox.ts` and `tests/paddle-sandbox.spec.ts` (read both): same fake-fetch test approach, same secret hygiene, same idempotency by `custom_data` markers. Catalog file (JSON, default `paddle.catalog.json` in cwd):
```json
{ "app": "offday",
  "product": { "name": "Offday", "taxCategory": "standard", "description": "…" },
  "prices": [
    { "key": "team25", "cycle": "monthly", "name": "Team up to 25 (monthly)", "amount": "1000", "currency": "USD", "quantity": { "min": 1, "max": 1 } },
    { "key": "pack5",  "cycle": "once",    "name": "5 dynamic QR codes",       "amount": "1499", "currency": "USD" } ] }
```
`cycle`: `monthly` | `yearly` | `once` (once → no `billing_cycle`). Markers: product `custom_data.paddle_kit = "<app>"`; price `custom_data.paddle_kit_price = "<key>-<cycle>"`. Output `PADDLE_PRICES` as PriceMap: keys with only `once` → flat string; recurring → `{ monthly, yearly }`. Library: `syncCatalog({ apiKey, catalog, webhookUrl?, envFile?, teardown?, fetch?, live? })` returns a summary; CLI flags `--catalog <path> --webhook-url <url> --env-file <path> (default .env.local) --teardown --live`. Webhook destination description `"<app> (paddle-kit)"`, `traffic_source: "all"`, the event list = paddle-kit's handled types (subscription.*, customer.created/updated, transaction.completed, transaction.paid, adjustment.created, adjustment.updated); read `endpoint_secret_key` from an existing destination instead of asking to copy it; write env incrementally; refuse to write `"undefined"`. Tests: empty account → creates product + prices (incl. one-time without billing_cycle); second run no-op; amount change → PATCH only that price; env file preserved + 0600; refuses live key without `--live`; output never contains key/secret. Commit `feat: paddle-kit-catalog for sandbox catalogs, destinations and client tokens`.

### Task 5: Docs, smoke, release

README: new sections "One-time purchases and refunds (hooks)", "Plan state", "Env validation (`readBillingEnv`) — build-safe pattern: construct `createBilling` only when `config` is non-null", "Catalog CLI", and an "Integration checklist" (default payment link — dashboard only, public URL, both sandbox and live; private-dependency CI token with ssh+https `insteadOf`; tunnel re-point; test card; drill). Bump version 0.3.0. Run `npx tsc --noEmit && npx vitest run && npm run build && npm run check:edge && npm run smoke`. Commit, merge to main, `scripts/release.sh 0.3.0`, push main + tag (owner pre-authorised pushes for this work on 2026-10-16).
