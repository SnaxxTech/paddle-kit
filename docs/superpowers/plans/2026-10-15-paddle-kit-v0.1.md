# paddle-kit v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a private, framework-agnostic TypeScript package that verifies Paddle Billing webhooks, mirrors subscription state into Postgres, and answers `hasAccess(userId, feature)` for any SnaxxTech web project.

**Architecture:** A zero-dependency `core` built only on Web-standard APIs (`Request`, `Response`, `crypto.subtle`) holds verification, event parsing, the access rule and the webhook handler. Storage sits behind a `Store` interface (memory + Postgres). Thin adapters (Next, Hono, Express), a Paddle.js checkout helper and a Node-only `reconcile` sit around the core as separate subpath exports.

**Tech Stack:** TypeScript 5, Node ≥ 20, ESM only, tsup (build), vitest (tests), `@electric-sql/pglite` (real Postgres in tests, no Docker), `@edge-runtime/vm` (edge test env), `@paddle/paddle-node-sdk` 3.10.0 (test oracle + reconcile), `@paddle/paddle-js` (checkout).

**Spec:** `docs/superpowers/specs/2026-10-15-paddle-kit-design.md` — read it before Task 1. This plan argues from it.

## Global Constraints

- Repo root: `/Users/gentlegen/Desktop/Projects/paddle-kit`. Branch `main`. No remote until the owner says so (Task 10).
- Paddle **Billing** (v2) only. Never Paddle Classic.
- `src/core/**`, `src/memory/**`, `src/postgres/**`, `src/next/**`, `src/hono/**` must not import any `node:` module or any runtime dependency. Only `src/express/**` (Node by nature), `src/reconcile/**` (uses the Node SDK) and `src/client/**` (browser, uses `@paddle/paddle-js`) may import packages, and those packages are optional `peerDependencies`.
- Signature: HMAC-SHA256 over `` `${ts}:${rawBody}` ``, header `Paddle-Signature: ts=<unix>;h1=<hex>[;h1=<hex>]`, default tolerance **5 s**, one-sided (`now > ts + tolerance` is stale), MAC checked before staleness, constant-time compare, any `h1` may match.
- The webhook path writes to the store only. No Paddle API call inside a webhook request (Paddle's 5 s delivery deadline).
- No log line, DB row or error message may contain the raw body, the signature header value, the webhook secret or an API key. Logs carry only `reason`, `eventId`, `eventType`.
- Reason codes (exact strings): `missing_body`, `missing_raw_body`, `bad_signature_header`, `signature_mismatch`, `stale_timestamp`, `bad_json`, `bad_payload`, `unknown_event`, `no_user_id`, `out_of_order`, `store_error`.
- Migrations are additive, tables prefixed `paddle_`, never edited after release; the package never runs DDL itself.
- Sandbox and live never mix: server API keys `pdl_sdbx_` ↔ sandbox, `pdl_live_` ↔ production; client tokens `test_` ↔ sandbox, `live_` ↔ production. A mismatch throws at construction.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Express app with `express.json()` mounted globally** — the body arrives already parsed. Expected: 500 with `missing_raw_body` logged, never a verification against re-serialised JSON. Pinned in Task 7.
2. **Subscription with no `custom_data.userId`** (created in the Paddle dashboard, imported, or a checkout that skipped the helper). Expected: row stored with `user_id NULL`, event reason `no_user_id`, `health().unlinkedLast24h` increments, nobody gains access. Pinned in Task 5.
3. **Out-of-order and duplicate delivery** — `subscription.updated` before `subscription.created`, and each delivered twice. Expected: final row equals the newest `occurred_at`; duplicates return 200 without reprocessing. Pinned in Task 5 (memory) and Task 6 (Postgres).
4. **Price missing from `entitlements`** (new price created in Paddle, config not updated) and **multi-item subscriptions** where only one item maps. Expected: unknown price grants nothing and does not throw; the mapped item still grants its features. Pinned in Task 3.
5. **Rotated or wrong-environment webhook secret** — every delivery fails. Expected: 401 `signature_mismatch` on each, `health().lastFailureReason === 'signature_mismatch'`, `failedLast24h` counts them, no request content stored. Pinned in Task 5 (drill).

## File map

```
package.json  tsconfig.json  tsup.config.ts  vitest.config.ts  .gitignore  README.md
migrations/001_init.sql                 # mirror of src/postgres/migrations.ts (equality-tested)
src/core/types.ts                       # all shared types + ReasonCode
src/core/signature.ts                   # parseSignatureHeader, verifySignature
src/core/events.ts                      # parseEvent → NormalisedEvent
src/core/access.ts                      # grantsAccess, decideAccess, nextPastDueSince
src/core/handler.ts                     # createWebhookHandler
src/core/billing.ts                     # createBilling (config guards, hasAccess, health)
src/core/index.ts                       # public re-exports
src/memory/index.ts                     # memoryStore
src/postgres/migrations.ts              # MIGRATIONS constant
src/postgres/index.ts                   # postgresStore
src/next/index.ts  src/hono/index.ts  src/express/index.ts
src/client/index.ts                     # createCheckout
src/reconcile/index.ts                  # reconcile, fromSdkSubscription
tests/helpers/sign.ts                   # node:crypto signer (independent of WebCrypto path)
tests/helpers/fixtures.ts               # load + override real Paddle payloads
tests/helpers/store-contract.ts         # shared Store contract suite
tests/fixtures/*.json  tests/fixtures/SOURCES.md
tests/*.test.ts
scripts/check-edge.mjs  scripts/smoke-pack.mjs  scripts/release.sh
```

---

### Task 1: Scaffold + signature verification

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `.gitignore`, `src/core/types.ts`, `src/core/signature.ts`, `tests/helpers/sign.ts`, `tests/signature.test.ts`

**Interfaces:**
- Produces: `ReasonCode`, `VerifyResult`, `parseSignatureHeader(header: string): { ts: number; h1: string[] } | null`, `verifySignature(input: { rawBody: string; header: string | null; secret: string; toleranceSeconds?: number; now?: number }): Promise<VerifyResult>`; test helper `sign(body: string, secret: string, ts?: number): string`.

- [ ] **Step 1: Scaffold**

```bash
cd /Users/gentlegen/Desktop/Projects/paddle-kit
npm init -y
npm i -D typescript tsup vitest @types/node @edge-runtime/vm @electric-sql/pglite @paddle/paddle-node-sdk@3.10.0 @paddle/paddle-js hono express @types/express tsx
```

`package.json` (replace the generated fields; keep the devDependencies npm wrote):

```json
{
  "name": "paddle-kit",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "files": ["dist", "migrations"],
  "exports": {
    "./core": { "types": "./dist/core/index.d.ts", "import": "./dist/core/index.js" },
    "./memory": { "types": "./dist/memory/index.d.ts", "import": "./dist/memory/index.js" },
    "./postgres": { "types": "./dist/postgres/index.d.ts", "import": "./dist/postgres/index.js" },
    "./next": { "types": "./dist/next/index.d.ts", "import": "./dist/next/index.js" },
    "./hono": { "types": "./dist/hono/index.d.ts", "import": "./dist/hono/index.js" },
    "./express": { "types": "./dist/express/index.d.ts", "import": "./dist/express/index.js" },
    "./client": { "types": "./dist/client/index.d.ts", "import": "./dist/client/index.js" },
    "./reconcile": { "types": "./dist/reconcile/index.d.ts", "import": "./dist/reconcile/index.js" }
  },
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "check:edge": "node scripts/check-edge.mjs",
    "smoke": "node scripts/smoke-pack.mjs"
  },
  "peerDependencies": {
    "@paddle/paddle-node-sdk": "^3.10.0",
    "@paddle/paddle-js": "^1.0.0",
    "hono": "^4.0.0",
    "express": "^4.18.0 || ^5.0.0"
  },
  "peerDependenciesMeta": {
    "@paddle/paddle-node-sdk": { "optional": true },
    "@paddle/paddle-js": { "optional": true },
    "hono": { "optional": true },
    "express": { "optional": true }
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "tests", "scripts"]
}
```

`tsup.config.ts`:

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'core/index': 'src/core/index.ts',
    'memory/index': 'src/memory/index.ts',
    'postgres/index': 'src/postgres/index.ts',
    'next/index': 'src/next/index.ts',
    'hono/index': 'src/hono/index.ts',
    'express/index': 'src/express/index.ts',
    'client/index': 'src/client/index.ts',
    'reconcile/index': 'src/reconcile/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: true,
  external: ['@paddle/paddle-node-sdk', '@paddle/paddle-js', 'hono', 'express'],
});
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });
```

`.gitignore`:

```
node_modules/
dist/
*.tgz
.env*
```

- [ ] **Step 2: Shared types**

`src/core/types.ts`:

```ts
export type ReasonCode =
  | 'missing_body'
  | 'missing_raw_body'
  | 'bad_signature_header'
  | 'signature_mismatch'
  | 'stale_timestamp'
  | 'bad_json'
  | 'bad_payload'
  | 'unknown_event'
  | 'no_user_id'
  | 'out_of_order'
  | 'store_error';

export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'paused' | 'canceled';
export type EventStatus = 'received' | 'processed' | 'ignored' | 'stale' | 'failed';

export interface ScheduledChange {
  action: string;
  effectiveAt: string;
}

export interface Subscription {
  subscriptionId: string;
  customerId: string;
  userId: string | null;
  status: SubscriptionStatus;
  priceIds: string[];
  currentPeriodEnd: string | null;
  scheduledChange: ScheduledChange | null;
  canceledAt: string | null;
  pastDueSince: string | null;
  /** occurred_at of the event (or updated_at from reconcile) that produced this row. */
  lastEventAt: string;
  raw: unknown;
}

export interface Customer {
  customerId: string;
  email: string | null;
  lastEventAt: string;
}

export interface Health {
  lastEventAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: ReasonCode | null;
  failedLast24h: number;
  unlinkedLast24h: number;
}

export interface Store {
  recordEvent(e: { eventId: string; eventType: string; occurredAt: string; receivedAt: string }): Promise<{ alreadyDone: boolean }>;
  markEvent(eventId: string, status: EventStatus, reason: ReasonCode | null): Promise<void>;
  recordFailure(reason: ReasonCode, at: Date): Promise<void>;
  upsertCustomer(c: Customer): Promise<{ applied: boolean }>;
  upsertSubscription(s: Subscription): Promise<{ applied: boolean }>;
  getSubscription(subscriptionId: string): Promise<Subscription | null>;
  getSubscriptionsByUser(userId: string): Promise<Subscription[]>;
  health(now: Date): Promise<Health>;
}

export interface LogEntry {
  level: 'warn' | 'error';
  reason: ReasonCode;
  eventId?: string;
  eventType?: string;
}
export type Logger = (entry: LogEntry) => void;
```

- [ ] **Step 3: Write the failing tests**

`tests/helpers/sign.ts` — deliberately uses `node:crypto`, not WebCrypto, so the test signer is an independent implementation:

```ts
import { createHmac } from 'node:crypto';

export function sign(body: string, secret: string, ts = Math.floor(Date.now() / 1000)): string {
  const h1 = createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
  return `ts=${ts};h1=${h1}`;
}
```

`tests/signature.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Paddle, Environment } from '@paddle/paddle-node-sdk';
import { parseSignatureHeader, verifySignature } from '../src/core/signature';
import { sign } from './helpers/sign';

const SECRET = 'pdl_ntfset_test_secret';
const BODY = '{"event_id":"evt_1","event_type":"subscription.created"}';
const oracle = new Paddle('pdl_sdbx_apikey_unused', { environment: Environment.sandbox });

describe('parseSignatureHeader', () => {
  it('parses ts and one or more h1', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    expect(parseSignatureHeader(`ts=1700000000;h1=${a};h1=${b}`)).toEqual({ ts: 1700000000, h1: [a, b] });
  });
  it.each(['', 'ts=abc;h1=' + 'a'.repeat(64), 'ts=1700000000', 'h1=' + 'a'.repeat(64), 'ts=1;h1=nothex'])(
    'rejects malformed header %j',
    (h) => expect(parseSignatureHeader(h)).toBeNull(),
  );
});

describe('verifySignature', () => {
  it('accepts a valid signature', async () => {
    const header = sign(BODY, SECRET);
    expect(await verifySignature({ rawBody: BODY, header, secret: SECRET })).toEqual({ ok: true });
  });
  it('rejects a missing header', async () => {
    expect(await verifySignature({ rawBody: BODY, header: null, secret: SECRET })).toEqual({ ok: false, reason: 'bad_signature_header' });
  });
  it('rejects a tampered body as signature_mismatch', async () => {
    const header = sign(BODY, SECRET);
    expect(await verifySignature({ rawBody: BODY + ' ', header, secret: SECRET })).toEqual({ ok: false, reason: 'signature_mismatch' });
  });
  it('rejects the wrong secret as signature_mismatch', async () => {
    const header = sign(BODY, 'other_secret');
    expect(await verifySignature({ rawBody: BODY, header, secret: SECRET })).toEqual({ ok: false, reason: 'signature_mismatch' });
  });
  it('reports a forged old header as signature_mismatch, not stale', async () => {
    const old = Math.floor(Date.now() / 1000) - 600;
    const header = sign(BODY, 'other_secret', old);
    expect(await verifySignature({ rawBody: BODY, header, secret: SECRET })).toEqual({ ok: false, reason: 'signature_mismatch' });
  });
  it('rejects a genuine signature older than the tolerance as stale', async () => {
    const ts = 1_700_000_000;
    const header = sign(BODY, SECRET, ts);
    expect(await verifySignature({ rawBody: BODY, header, secret: SECRET, now: (ts + 6) * 1000 })).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(await verifySignature({ rawBody: BODY, header, secret: SECRET, now: (ts + 5) * 1000 })).toEqual({ ok: true });
  });
  it('does not reject a future timestamp (one-sided, same as the SDK)', async () => {
    const ts = 1_700_000_000;
    const header = sign(BODY, SECRET, ts);
    expect(await verifySignature({ rawBody: BODY, header, secret: SECRET, now: (ts - 60) * 1000 })).toEqual({ ok: true });
  });
  it('accepts when any of several h1 values matches (secret rotation)', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const good = sign(BODY, SECRET, ts).split(';')[1];
    const bad = sign(BODY, 'old_secret', ts).split(';')[1];
    expect(await verifySignature({ rawBody: BODY, header: `ts=${ts};${good};${bad}`, secret: SECRET })).toEqual({ ok: true });
  });
});

describe('agrees with the official SDK verifier', () => {
  const now = () => Math.floor(Date.now() / 1000);
  const cases: Array<[string, () => { body: string; header: string }]> = [
    ['valid', () => ({ body: BODY, header: sign(BODY, SECRET, now()) })],
    ['tampered', () => ({ body: BODY + 'x', header: sign(BODY, SECRET, now()) })],
    ['wrong secret', () => ({ body: BODY, header: sign(BODY, 'nope', now()) })],
    ['stale', () => ({ body: BODY, header: sign(BODY, SECRET, now() - 60) })],
    ['unicode body', () => ({ body: '{"name":"Zoë ✓"}', header: sign('{"name":"Zoë ✓"}', SECRET, now()) })],
  ];
  it.each(cases)('%s', async (_name, make) => {
    const { body, header } = make();
    const ours = (await verifySignature({ rawBody: body, header, secret: SECRET })).ok;
    const theirs = await oracle.webhooks.isSignatureValid(body, SECRET, header);
    expect(ours).toBe(theirs);
  });
});
```

- [ ] **Step 4: Run to see it fail**

Run: `npx vitest run tests/signature.test.ts`
Expected: FAIL — cannot resolve `../src/core/signature`.

- [ ] **Step 5: Implement**

`src/core/signature.ts`:

```ts
import type { ReasonCode } from './types';

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: Extract<ReasonCode, 'bad_signature_header' | 'signature_mismatch' | 'stale_timestamp'> };

const encoder = new TextEncoder();

export function parseSignatureHeader(header: string): { ts: number; h1: string[] } | null {
  let ts: number | undefined;
  const h1: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 'ts' && /^\d+$/.test(value)) ts = Number(value);
    else if (key === 'h1' && /^[0-9a-f]{64}$/i.test(value)) h1.push(value.toLowerCase());
  }
  return ts !== undefined && h1.length > 0 ? { ts, h1 } : null;
}

export async function verifySignature(input: {
  rawBody: string;
  header: string | null;
  secret: string;
  toleranceSeconds?: number;
  now?: number;
}): Promise<VerifyResult> {
  const parsed = input.header ? parseSignatureHeader(input.header) : null;
  if (!parsed) return { ok: false, reason: 'bad_signature_header' };

  const key = await crypto.subtle.importKey('raw', encoder.encode(input.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${parsed.ts}:${input.rawBody}`)));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  if (!parsed.h1.some((candidate) => constantTimeEqual(candidate, expected))) {
    return { ok: false, reason: 'signature_mismatch' };
  }

  const tolerance = input.toleranceSeconds ?? 5;
  const now = input.now ?? Date.now();
  if (now > (parsed.ts + tolerance) * 1000) return { ok: false, reason: 'stale_timestamp' };
  return { ok: true };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
```

- [ ] **Step 6: Run to see it pass**

Run: `npx vitest run tests/signature.test.ts && npx tsc --noEmit`
Expected: all tests PASS, no type errors. If any oracle case disagrees, stop and report — do not adjust the test to match.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): verify Paddle webhook signatures with Web Crypto

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Real fixtures + event parsing

**Files:**
- Create: `tests/fixtures/subscription.created.json`, `tests/fixtures/subscription.updated.json`, `tests/fixtures/subscription.canceled.json`, `tests/fixtures/customer.created.json`, `tests/fixtures/transaction.completed.json`, `tests/fixtures/SOURCES.md`, `tests/helpers/fixtures.ts`, `src/core/events.ts`, `tests/events.test.ts`

**Interfaces:**
- Consumes: `Subscription`, `Customer`, `SubscriptionStatus` from Task 1.
- Produces: `NormalisedEvent`, `SubscriptionInput` (= `Omit<Subscription, 'pastDueSince'>`), `parseEvent(json: unknown): NormalisedEvent | null`, `SUBSCRIPTION_EVENT_TYPES: ReadonlySet<string>`; helpers `loadFixture(name: string): any`, `subscriptionEvent(overrides?: { eventId?: string; eventType?: string; occurredAt?: string; data?: Record<string, unknown> }): any`.

- [ ] **Step 1: Capture real payloads (no hand-written fixtures)**

Preferred source, in order:
1. Paddle **sandbox webhook simulator** (dashboard → Developer tools → Simulations, or the `paddle-sandbox` MCP from the `paddle@claude-community` plugin once the owner has set its sandbox key) sent to a tunnel (`hookdeck listen 3000` or `ngrok http 3000`) with a 10-line Node server that writes each raw body to a file.
2. If no sandbox access yet: the example payloads on Paddle's webhook reference pages, e.g. `https://developer.paddle.com/webhooks/subscriptions/subscription-created` (and `-updated`, `-canceled`, `customers/customer-created`, `transactions/transaction-completed`).

Save each as pretty-printed JSON with the full envelope (`event_id`, `event_type`, `occurred_at`, `notification_id`, `data`). In `tests/fixtures/SOURCES.md`, list each file with its source (simulator run id, or URL) and capture date. Do not edit field values except `data.custom_data`, which must be set to `{"userId":"user_1"}` in `subscription.created.json` (record that edit in SOURCES.md).

- [ ] **Step 2: Fixture helpers**

`tests/helpers/fixtures.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../fixtures/', import.meta.url));

export function loadFixture(name: string): any {
  return JSON.parse(readFileSync(`${dir}${name}.json`, 'utf8'));
}

/** A real subscription.created payload with selected envelope/data fields overridden. */
export function subscriptionEvent(o: { eventId?: string; eventType?: string; occurredAt?: string; data?: Record<string, unknown> } = {}): any {
  const base = loadFixture('subscription.created');
  return {
    ...base,
    event_id: o.eventId ?? base.event_id,
    event_type: o.eventType ?? base.event_type,
    occurred_at: o.occurredAt ?? base.occurred_at,
    data: { ...base.data, ...(o.data ?? {}) },
  };
}
```

- [ ] **Step 3: Write the failing tests**

`tests/events.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseEvent } from '../src/core/events';
import { loadFixture, subscriptionEvent } from './helpers/fixtures';

describe('parseEvent', () => {
  it('normalises a real subscription.created payload', () => {
    const raw = loadFixture('subscription.created');
    const ev = parseEvent(raw);
    expect(ev?.kind).toBe('subscription');
    if (ev?.kind !== 'subscription') return;
    expect(ev.eventId).toBe(raw.event_id);
    expect(ev.occurredAt).toBe(raw.occurred_at);
    expect(ev.subscription.subscriptionId).toBe(raw.data.id);
    expect(ev.subscription.customerId).toBe(raw.data.customer_id);
    expect(ev.subscription.status).toBe(raw.data.status);
    expect(ev.subscription.priceIds).toEqual(raw.data.items.map((i: any) => i.price.id));
    expect(ev.subscription.userId).toBe('user_1');
    expect(ev.subscription.lastEventAt).toBe(raw.occurred_at);
  });

  it('normalises updated and canceled payloads', () => {
    for (const name of ['subscription.updated', 'subscription.canceled']) {
      const ev = parseEvent(loadFixture(name));
      expect(ev?.kind, name).toBe('subscription');
    }
  });

  it('maps scheduled_change and current_billing_period', () => {
    const ev = parseEvent(
      subscriptionEvent({
        data: {
          scheduled_change: { action: 'cancel', effective_at: '2026-11-01T00:00:00Z', resume_at: null },
          current_billing_period: { starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-11-01T00:00:00Z' },
        },
      }),
    );
    if (ev?.kind !== 'subscription') throw new Error('expected subscription');
    expect(ev.subscription.scheduledChange).toEqual({ action: 'cancel', effectiveAt: '2026-11-01T00:00:00Z' });
    expect(ev.subscription.currentPeriodEnd).toBe('2026-11-01T00:00:00Z');
  });

  it.each([{}, { userId: '' }, { userId: 42 }, null])('treats custom_data %j as no user', (custom) => {
    const ev = parseEvent(subscriptionEvent({ data: { custom_data: custom } }));
    if (ev?.kind !== 'subscription') throw new Error('expected subscription');
    expect(ev.subscription.userId).toBeNull();
  });

  it('treats subscription.imported like a subscription event', () => {
    expect(parseEvent(subscriptionEvent({ eventType: 'subscription.imported' }))?.kind).toBe('subscription');
  });

  it('normalises customer.created', () => {
    const raw = loadFixture('customer.created');
    expect(parseEvent(raw)).toEqual({
      kind: 'customer',
      eventId: raw.event_id,
      eventType: 'customer.created',
      occurredAt: raw.occurred_at,
      customer: { customerId: raw.data.id, email: raw.data.email ?? null, lastEventAt: raw.occurred_at },
    });
  });

  it('records transaction.completed without state', () => {
    expect(parseEvent(loadFixture('transaction.completed'))?.kind).toBe('record-only');
  });

  it('marks unknown event types as ignored', () => {
    expect(parseEvent({ event_id: 'evt_x', event_type: 'payout.paid', occurred_at: '2026-10-15T00:00:00Z', data: {} })?.kind).toBe('ignored');
  });

  it.each([
    ['not an object', 'x'],
    ['no event_id', { event_type: 'subscription.created', occurred_at: '2026-10-15T00:00:00Z', data: {} }],
    ['bad occurred_at', { event_id: 'e', event_type: 'subscription.created', occurred_at: 'yesterday', data: {} }],
    ['unknown status', subscriptionEvent({ data: { status: 'zombie' } })],
    ['items not array', subscriptionEvent({ data: { items: null } })],
    ['missing customer_id', subscriptionEvent({ data: { customer_id: undefined } })],
  ])('returns null for malformed input: %s', (_n, input) => {
    expect(parseEvent(input)).toBeNull();
  });
});
```

- [ ] **Step 4: Run to see it fail**

Run: `npx vitest run tests/events.test.ts`
Expected: FAIL — cannot resolve `../src/core/events`.

- [ ] **Step 5: Implement**

`src/core/events.ts`:

```ts
import type { Customer, Subscription, SubscriptionStatus } from './types';

export type SubscriptionInput = Omit<Subscription, 'pastDueSince'>;

interface Envelope {
  eventId: string;
  eventType: string;
  occurredAt: string;
}

export type NormalisedEvent =
  | (Envelope & { kind: 'subscription'; subscription: SubscriptionInput })
  | (Envelope & { kind: 'customer'; customer: Customer })
  | (Envelope & { kind: 'record-only' })
  | (Envelope & { kind: 'ignored' });

export const SUBSCRIPTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'subscription.created',
  'subscription.imported',
  'subscription.updated',
  'subscription.activated',
  'subscription.trialing',
  'subscription.past_due',
  'subscription.paused',
  'subscription.resumed',
  'subscription.canceled',
]);
const CUSTOMER_EVENT_TYPES: ReadonlySet<string> = new Set(['customer.created', 'customer.updated']);
const RECORD_ONLY_EVENT_TYPES: ReadonlySet<string> = new Set(['transaction.completed']);
const STATUSES: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due', 'paused', 'canceled']);

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isTime = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const optStr = (v: unknown): string | null => (isStr(v) ? v : null);

export function parseEvent(json: unknown): NormalisedEvent | null {
  if (!isObj(json) || !isStr(json.event_id) || !isStr(json.event_type) || !isTime(json.occurred_at) || !isObj(json.data)) {
    return null;
  }
  const env: Envelope = { eventId: json.event_id, eventType: json.event_type, occurredAt: json.occurred_at };
  const data = json.data;

  if (SUBSCRIPTION_EVENT_TYPES.has(env.eventType)) {
    if (!isStr(data.id) || !isStr(data.customer_id) || !STATUSES.has(data.status) || !Array.isArray(data.items)) return null;
    const priceIds = data.items.map((item: any) => item?.price?.id).filter(isStr);
    const sc = isObj(data.scheduled_change) && isStr(data.scheduled_change.action) && isTime(data.scheduled_change.effective_at)
      ? { action: data.scheduled_change.action, effectiveAt: data.scheduled_change.effective_at }
      : null;
    return {
      ...env,
      kind: 'subscription',
      subscription: {
        subscriptionId: data.id,
        customerId: data.customer_id,
        userId: isObj(data.custom_data) ? optStr(data.custom_data.userId) : null,
        status: data.status as SubscriptionStatus,
        priceIds,
        currentPeriodEnd: isObj(data.current_billing_period) ? optStr(data.current_billing_period.ends_at) : null,
        scheduledChange: sc,
        canceledAt: optStr(data.canceled_at),
        lastEventAt: env.occurredAt,
        raw: data,
      },
    };
  }
  if (CUSTOMER_EVENT_TYPES.has(env.eventType)) {
    if (!isStr(data.id)) return null;
    return { ...env, kind: 'customer', customer: { customerId: data.id, email: optStr(data.email), lastEventAt: env.occurredAt } };
  }
  if (RECORD_ONLY_EVENT_TYPES.has(env.eventType)) return { ...env, kind: 'record-only' };
  return { ...env, kind: 'ignored' };
}
```

- [ ] **Step 6: Run to see it pass**

Run: `npx vitest run tests/events.test.ts && npx tsc --noEmit`
Expected: PASS. If a real fixture fails to parse, the fixture is the truth: fix the parser, and note the field difference in SOURCES.md.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): normalise real Paddle webhook payloads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Access rule (pure)

**Files:**
- Create: `src/core/access.ts`, `tests/access.test.ts`

**Interfaces:**
- Consumes: `Subscription`, `SubscriptionStatus`.
- Produces: `AccessPolicy { entitlements: Record<string, readonly string[]>; pastDueGraceDays: number }`, `grantsAccess(sub: Subscription, now: Date, graceDays: number): boolean`, `decideAccess(subs: Subscription[], feature: string, policy: AccessPolicy, now: Date): boolean`, `nextPastDueSince(prev: Subscription | null, status: SubscriptionStatus, occurredAt: string): string | null`.

- [ ] **Step 1: Write the failing tests**

`tests/access.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decideAccess, grantsAccess, nextPastDueSince } from '../src/core/access';
import type { Subscription } from '../src/core/types';

const NOW = new Date('2026-10-15T12:00:00Z');
const DAY = 86_400_000;
const sub = (o: Partial<Subscription> = {}): Subscription => ({
  subscriptionId: 'sub_1', customerId: 'ctm_1', userId: 'user_1', status: 'active', priceIds: ['pri_pro'],
  currentPeriodEnd: null, scheduledChange: null, canceledAt: null, pastDueSince: null,
  lastEventAt: '2026-10-01T00:00:00Z', raw: {}, ...o,
});
const policy = { entitlements: { pri_pro: ['pro'], pri_team: ['pro', 'team'] }, pastDueGraceDays: 7 };

describe('grantsAccess', () => {
  it.each([['active', true], ['trialing', true], ['paused', false], ['canceled', false]] as const)('%s → %s', (status, want) => {
    expect(grantsAccess(sub({ status }), NOW, 7)).toBe(want);
  });
  it('keeps access while a cancel is only scheduled (status still active)', () => {
    expect(grantsAccess(sub({ scheduledChange: { action: 'cancel', effectiveAt: '2026-11-01T00:00:00Z' } }), NOW, 7)).toBe(true);
  });
  it('grants past_due inside grace, inclusive of the boundary', () => {
    expect(grantsAccess(sub({ status: 'past_due', pastDueSince: new Date(NOW.getTime() - 7 * DAY).toISOString() }), NOW, 7)).toBe(true);
  });
  it('denies past_due one ms after grace', () => {
    expect(grantsAccess(sub({ status: 'past_due', pastDueSince: new Date(NOW.getTime() - 7 * DAY - 1).toISOString() }), NOW, 7)).toBe(false);
  });
  it('grants past_due with unknown start (treated as just started)', () => {
    expect(grantsAccess(sub({ status: 'past_due', pastDueSince: null }), NOW, 7)).toBe(true);
  });
});

describe('decideAccess', () => {
  it('grants a feature mapped from the price', () => {
    expect(decideAccess([sub()], 'pro', policy, NOW)).toBe(true);
    expect(decideAccess([sub()], 'team', policy, NOW)).toBe(false);
  });
  it('unknown price grants nothing and does not throw', () => {
    expect(decideAccess([sub({ priceIds: ['pri_new_unmapped'] })], 'pro', policy, NOW)).toBe(false);
  });
  it('multi-item: the mapped item still grants', () => {
    expect(decideAccess([sub({ priceIds: ['pri_addon_unmapped', 'pri_team'] })], 'team', policy, NOW)).toBe(true);
  });
  it('any qualifying subscription is enough', () => {
    expect(decideAccess([sub({ status: 'canceled' }), sub({ subscriptionId: 'sub_2', status: 'trialing' })], 'pro', policy, NOW)).toBe(true);
  });
  it('no subscriptions → false', () => {
    expect(decideAccess([], 'pro', policy, NOW)).toBe(false);
  });
});

describe('nextPastDueSince', () => {
  it('starts the clock on the first past_due', () => {
    expect(nextPastDueSince(sub(), 'past_due', '2026-10-10T00:00:00Z')).toBe('2026-10-10T00:00:00Z');
  });
  it('keeps the original start across repeated past_due events', () => {
    expect(nextPastDueSince(sub({ status: 'past_due', pastDueSince: '2026-10-05T00:00:00Z' }), 'past_due', '2026-10-10T00:00:00Z')).toBe('2026-10-05T00:00:00Z');
  });
  it('clears when leaving past_due', () => {
    expect(nextPastDueSince(sub({ status: 'past_due', pastDueSince: '2026-10-05T00:00:00Z' }), 'active', '2026-10-10T00:00:00Z')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/access.test.ts`
Expected: FAIL — cannot resolve `../src/core/access`.

- [ ] **Step 3: Implement**

`src/core/access.ts`:

```ts
import type { Subscription, SubscriptionStatus } from './types';

export interface AccessPolicy {
  entitlements: Record<string, readonly string[]>;
  pastDueGraceDays: number;
}

const DAY_MS = 86_400_000;

export function grantsAccess(sub: Subscription, now: Date, graceDays: number): boolean {
  switch (sub.status) {
    case 'active':
    case 'trialing':
      return true;
    case 'past_due':
      if (!sub.pastDueSince) return true;
      return now.getTime() - Date.parse(sub.pastDueSince) <= graceDays * DAY_MS;
    default:
      return false;
  }
}

export function decideAccess(subs: Subscription[], feature: string, policy: AccessPolicy, now: Date): boolean {
  return subs.some(
    (s) => grantsAccess(s, now, policy.pastDueGraceDays) && s.priceIds.some((p) => policy.entitlements[p]?.includes(feature) ?? false),
  );
}

export function nextPastDueSince(prev: Subscription | null, status: SubscriptionStatus, occurredAt: string): string | null {
  if (status !== 'past_due') return null;
  if (prev?.status === 'past_due' && prev.pastDueSince) return prev.pastDueSince;
  return occurredAt;
}
```

- [ ] **Step 4: Run to see it pass**

Run: `npx vitest run tests/access.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): decide feature access from subscription state

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Store contract + memory store

**Files:**
- Create: `tests/helpers/store-contract.ts`, `src/memory/index.ts`, `tests/memory-store.test.ts`

**Interfaces:**
- Consumes: `Store`, `Subscription`, `Customer`, `Health`, `EventStatus`, `ReasonCode`.
- Produces: `memoryStore(): Store`; `runStoreContract(name: string, makeStore: () => Promise<Store>): void`.

Contract semantics every store must meet (the suite enforces them):
- `recordEvent` inserts `received`; on an existing id it returns `alreadyDone: true` iff the stored status is `processed`, `ignored` or `stale` (a `received`/`failed` event is reprocessed).
- `upsertSubscription` / `upsertCustomer` apply iff no row exists or `existing.lastEventAt <= incoming.lastEventAt`; return `{ applied }`. A `null` incoming `userId` never overwrites a stored non-null one.
- `health(now)`: `lastEventAt` = newest `receivedAt` among `processed|ignored|stale`; failures = events marked `failed` plus `recordFailure` hits, counted over `(now − 24 h, now]`; `lastFailureAt/Reason` = the newest of either; `unlinkedLast24h` = events with reason `no_user_id` in the window.

- [ ] **Step 1: Write the contract suite**

`tests/helpers/store-contract.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { Store, Subscription } from '../../src/core/types';

const sub = (o: Partial<Subscription> = {}): Subscription => ({
  subscriptionId: 'sub_1', customerId: 'ctm_1', userId: 'user_1', status: 'active', priceIds: ['pri_pro'],
  currentPeriodEnd: '2026-11-01T00:00:00.000Z', scheduledChange: null, canceledAt: null, pastDueSince: null,
  lastEventAt: '2026-10-10T00:00:00.000Z', raw: { id: 'sub_1' }, ...o,
});
const ev = (id: string, receivedAt = '2026-10-15T10:00:00.000Z') => ({
  eventId: id, eventType: 'subscription.updated', occurredAt: '2026-10-15T09:59:59.000Z', receivedAt,
});

export function runStoreContract(name: string, makeStore: () => Promise<Store>): void {
  describe(`Store contract: ${name}`, () => {
    let store: Store;
    beforeEach(async () => { store = await makeStore(); });

    it('dedupes finished events but reprocesses received/failed ones', async () => {
      expect(await store.recordEvent(ev('evt_1'))).toEqual({ alreadyDone: false });
      expect(await store.recordEvent(ev('evt_1'))).toEqual({ alreadyDone: false });
      await store.markEvent('evt_1', 'failed', 'store_error');
      expect(await store.recordEvent(ev('evt_1'))).toEqual({ alreadyDone: false });
      for (const status of ['processed', 'ignored', 'stale'] as const) {
        await store.markEvent('evt_1', status, null);
        expect(await store.recordEvent(ev('evt_1'))).toEqual({ alreadyDone: true });
      }
    });

    it('round-trips a subscription', async () => {
      const s = sub({ scheduledChange: { action: 'cancel', effectiveAt: '2026-11-01T00:00:00.000Z' }, priceIds: ['a', 'b'] });
      expect(await store.upsertSubscription(s)).toEqual({ applied: true });
      expect(await store.getSubscription('sub_1')).toEqual(s);
      expect(await store.getSubscriptionsByUser('user_1')).toEqual([s]);
      expect(await store.getSubscription('nope')).toBeNull();
    });

    it('applies newer-or-equal, rejects older', async () => {
      await store.upsertSubscription(sub({ status: 'active', lastEventAt: '2026-10-10T00:00:00.000Z' }));
      expect(await store.upsertSubscription(sub({ status: 'canceled', lastEventAt: '2026-10-09T00:00:00.000Z' }))).toEqual({ applied: false });
      expect((await store.getSubscription('sub_1'))?.status).toBe('active');
      expect(await store.upsertSubscription(sub({ status: 'past_due', lastEventAt: '2026-10-10T00:00:00.000Z' }))).toEqual({ applied: true });
      expect(await store.upsertSubscription(sub({ status: 'canceled', lastEventAt: '2026-10-11T00:00:00.000Z' }))).toEqual({ applied: true });
      expect((await store.getSubscription('sub_1'))?.status).toBe('canceled');
    });

    it('never erases a known userId with null', async () => {
      await store.upsertSubscription(sub({ userId: 'user_1' }));
      await store.upsertSubscription(sub({ userId: null, lastEventAt: '2026-10-12T00:00:00.000Z' }));
      expect((await store.getSubscription('sub_1'))?.userId).toBe('user_1');
    });

    it('applies customers with the same ordering rule', async () => {
      expect(await store.upsertCustomer({ customerId: 'ctm_1', email: 'a@x.com', lastEventAt: '2026-10-10T00:00:00.000Z' })).toEqual({ applied: true });
      expect(await store.upsertCustomer({ customerId: 'ctm_1', email: 'old@x.com', lastEventAt: '2026-10-09T00:00:00.000Z' })).toEqual({ applied: false });
    });

    it('reports health over a 24h window', async () => {
      const now = new Date('2026-10-15T12:00:00.000Z');
      expect(await store.health(now)).toEqual({ lastEventAt: null, lastFailureAt: null, lastFailureReason: null, failedLast24h: 0, unlinkedLast24h: 0 });

      await store.recordEvent(ev('evt_ok', '2026-10-15T10:00:00.000Z'));
      await store.markEvent('evt_ok', 'processed', null);
      await store.recordEvent(ev('evt_unlinked', '2026-10-15T10:30:00.000Z'));
      await store.markEvent('evt_unlinked', 'processed', 'no_user_id');
      await store.recordEvent(ev('evt_old_fail', '2026-10-13T10:00:00.000Z'));
      await store.markEvent('evt_old_fail', 'failed', 'store_error');
      await store.recordFailure('signature_mismatch', new Date('2026-10-15T11:00:00.000Z'));
      await store.recordFailure('signature_mismatch', new Date('2026-10-15T11:00:20.000Z'));

      expect(await store.health(now)).toEqual({
        lastEventAt: '2026-10-15T10:30:00.000Z',
        lastFailureAt: '2026-10-15T11:00:20.000Z',
        lastFailureReason: 'signature_mismatch',
        failedLast24h: 2,
        unlinkedLast24h: 1,
      });
    });
  });
}
```

`tests/memory-store.test.ts`:

```ts
import { memoryStore } from '../src/memory';
import { runStoreContract } from './helpers/store-contract';

runStoreContract('memory', async () => memoryStore());
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/memory-store.test.ts`
Expected: FAIL — cannot resolve `../src/memory`.

- [ ] **Step 3: Implement**

`src/memory/index.ts`:

```ts
import type { Customer, EventStatus, Health, ReasonCode, Store, Subscription } from '../core/types';

interface EventRow { eventId: string; receivedAt: string; status: EventStatus; reason: ReasonCode | null }
interface FailureHit { at: string; reason: ReasonCode }

const DAY_MS = 86_400_000;
const DONE: ReadonlySet<EventStatus> = new Set(['processed', 'ignored', 'stale']);
const clone = <T>(v: T): T => structuredClone(v);

export function memoryStore(): Store {
  const events = new Map<string, EventRow>();
  const failures: FailureHit[] = [];
  const subs = new Map<string, Subscription>();
  const customers = new Map<string, Customer>();

  return {
    async recordEvent(e) {
      const existing = events.get(e.eventId);
      if (existing) return { alreadyDone: DONE.has(existing.status) };
      events.set(e.eventId, { eventId: e.eventId, receivedAt: e.receivedAt, status: 'received', reason: null });
      return { alreadyDone: false };
    },
    async markEvent(eventId, status, reason) {
      const row = events.get(eventId);
      if (row) Object.assign(row, { status, reason });
    },
    async recordFailure(reason, at) {
      failures.push({ at: at.toISOString(), reason });
    },
    async upsertCustomer(c) {
      const prev = customers.get(c.customerId);
      if (prev && Date.parse(prev.lastEventAt) > Date.parse(c.lastEventAt)) return { applied: false };
      customers.set(c.customerId, clone(c));
      return { applied: true };
    },
    async upsertSubscription(s) {
      const prev = subs.get(s.subscriptionId);
      if (prev && Date.parse(prev.lastEventAt) > Date.parse(s.lastEventAt)) return { applied: false };
      subs.set(s.subscriptionId, clone({ ...s, userId: s.userId ?? prev?.userId ?? null }));
      return { applied: true };
    },
    async getSubscription(id) {
      const s = subs.get(id);
      return s ? clone(s) : null;
    },
    async getSubscriptionsByUser(userId) {
      return [...subs.values()].filter((s) => s.userId === userId).map(clone);
    },
    async health(now): Promise<Health> {
      const since = now.getTime() - DAY_MS;
      const inWindow = (iso: string) => Date.parse(iso) > since && Date.parse(iso) <= now.getTime();
      const rows = [...events.values()];
      const done = rows.filter((r) => DONE.has(r.status)).map((r) => r.receivedAt).sort();
      const fails: FailureHit[] = [
        ...rows.filter((r) => r.status === 'failed').map((r) => ({ at: r.receivedAt, reason: r.reason ?? 'store_error' })),
        ...failures,
      ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const last = fails.at(-1);
      return {
        lastEventAt: done.at(-1) ?? null,
        lastFailureAt: last?.at ?? null,
        lastFailureReason: last?.reason ?? null,
        failedLast24h: fails.filter((f) => inWindow(f.at)).length,
        unlinkedLast24h: rows.filter((r) => r.reason === 'no_user_id' && inWindow(r.receivedAt)).length,
      };
    },
  };
}
```

- [ ] **Step 4: Run to see it pass**

Run: `npx vitest run tests/memory-store.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(memory): in-memory Store with the shared contract suite

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Webhook handler + billing facade + drill

**Files:**
- Create: `src/core/handler.ts`, `src/core/billing.ts`, `src/core/index.ts`, `tests/handler.test.ts`, `tests/billing.test.ts`

**Interfaces:**
- Consumes: `verifySignature` (T1), `parseEvent` (T2), `decideAccess`, `nextPastDueSince` (T3), `Store` + `memoryStore` (T3).
- Produces:
  - `createWebhookHandler(deps: { store: Store; secret: string; toleranceSeconds: number; log: Logger; now: () => Date }): (req: Request) => Promise<Response>`
  - `BillingConfig`, `Billing`, `createBilling(config: BillingConfig): Billing` where
    `Billing = { config: Readonly<BillingConfig>; store: Store; log: Logger; handleWebhook(req: Request): Promise<Response>; handleHealth(req: Request): Promise<Response>; hasAccess(userId: string, feature: string): Promise<boolean>; getSubscriptions(userId: string): Promise<Subscription[]>; health(): Promise<Health>; recordFailure(reason: ReasonCode): Promise<void> }`
  - `src/core/index.ts` re-exports everything public from `types`, `signature`, `events`, `access`, `handler`, `billing`.

- [ ] **Step 1: Write the failing handler tests (including the drill)**

`tests/handler.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebhookHandler } from '../src/core/handler';
import { memoryStore } from '../src/memory';
import type { LogEntry, Store } from '../src/core/types';
import { sign } from './helpers/sign';
import { loadFixture, subscriptionEvent } from './helpers/fixtures';

const SECRET = 'pdl_ntfset_test';
const NOW = new Date('2026-10-15T12:00:00Z');
const nowSec = Math.floor(NOW.getTime() / 1000);

function post(body: string, header: string | null = sign(body, SECRET, nowSec)) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (header) headers.set('paddle-signature', header);
  return new Request('https://app.test/api/paddle', { method: 'POST', headers, body });
}

describe('webhook handler', () => {
  let store: Store;
  let logs: LogEntry[];
  let handle: (r: Request) => Promise<Response>;
  beforeEach(() => {
    store = memoryStore();
    logs = [];
    handle = createWebhookHandler({ store, secret: SECRET, toleranceSeconds: 5, log: (e) => logs.push(e), now: () => NOW });
  });

  it('stores a real subscription.created and acks 200', async () => {
    const raw = loadFixture('subscription.created');
    const res = await handle(post(JSON.stringify(raw)));
    expect(res.status).toBe(200);
    expect((await store.getSubscription(raw.data.id))?.userId).toBe('user_1');
    expect((await store.health(NOW)).lastEventAt).toBe(NOW.toISOString());
  });

  it('returns 405 for non-POST', async () => {
    expect((await handle(new Request('https://app.test/api/paddle'))).status).toBe(405);
  });

  it('acks a duplicate without reprocessing', async () => {
    const body = JSON.stringify(subscriptionEvent({ eventId: 'evt_dup' }));
    await handle(post(body));
    const spy = vi.spyOn(store, 'upsertSubscription');
    const res = await handle(post(body));
    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it('converges on the newest state when events arrive out of order and twice', async () => {
    const created = JSON.stringify(subscriptionEvent({ eventId: 'evt_c', occurredAt: '2026-10-15T10:00:00Z', data: { status: 'active' } }));
    const updated = JSON.stringify(subscriptionEvent({ eventId: 'evt_u', eventType: 'subscription.updated', occurredAt: '2026-10-15T11:00:00Z', data: { status: 'paused' } }));
    for (const b of [updated, created, updated, created]) expect((await handle(post(b))).status).toBe(200);
    const id = loadFixture('subscription.created').data.id;
    expect((await store.getSubscription(id))?.status).toBe('paused');
    expect(logs).toContainEqual(expect.objectContaining({ reason: 'out_of_order', eventId: 'evt_c' }));
  });

  it('stores a subscription without userId and surfaces it', async () => {
    const body = JSON.stringify(subscriptionEvent({ eventId: 'evt_nouser', data: { custom_data: null } }));
    expect((await handle(post(body))).status).toBe(200);
    expect((await store.health(NOW)).unlinkedLast24h).toBe(1);
    expect(logs).toContainEqual(expect.objectContaining({ reason: 'no_user_id' }));
  });

  it('starts and keeps the past_due clock', async () => {
    const id = loadFixture('subscription.created').data.id;
    await handle(post(JSON.stringify(subscriptionEvent({ eventId: 'e1', eventType: 'subscription.past_due', occurredAt: '2026-10-10T00:00:00Z', data: { status: 'past_due' } }))));
    await handle(post(JSON.stringify(subscriptionEvent({ eventId: 'e2', eventType: 'subscription.updated', occurredAt: '2026-10-12T00:00:00Z', data: { status: 'past_due' } }))));
    expect((await store.getSubscription(id))?.pastDueSince).toBe('2026-10-10T00:00:00Z');
  });

  it('ignores unknown event types with 200', async () => {
    const body = JSON.stringify({ event_id: 'evt_p', event_type: 'payout.paid', occurred_at: '2026-10-15T00:00:00Z', data: {} });
    expect((await handle(post(body))).status).toBe(200);
  });

  describe('drill (spec §8): each failure gives the right status, reason and health change', () => {
    const body = JSON.stringify(subscriptionEvent({ eventId: 'evt_drill' }));
    it.each([
      ['wrong secret', () => post(body, sign(body, 'pdl_ntfset_rotated', nowSec)), 401, 'signature_mismatch'],
      ['tampered body', () => post(body.replace('user_1', 'user_2'), sign(body, SECRET, nowSec)), 401, 'signature_mismatch'],
      ['10-minute-old timestamp', () => post(body, sign(body, SECRET, nowSec - 600)), 401, 'stale_timestamp'],
      ['missing header', () => post(body, null), 400, 'bad_signature_header'],
      ['empty body', () => post('', sign('', SECRET, nowSec)), 400, 'missing_body'],
      ['signed but not JSON', () => post('not json', sign('not json', SECRET, nowSec)), 400, 'bad_json'],
      ['signed but malformed payload', () => post('{"event_id":"x"}', sign('{"event_id":"x"}', SECRET, nowSec)), 400, 'bad_payload'],
    ] as const)('%s', async (_n, make, status, reason) => {
      const res = await handle(make());
      expect(res.status).toBe(status);
      expect(logs).toContainEqual(expect.objectContaining({ reason }));
      const h = await store.health(NOW);
      expect(h.lastFailureReason).toBe(reason);
      expect(h.failedLast24h).toBe(1);
    });

    it('store failure → 500, event marked failed, retry succeeds', async () => {
      const real = store.upsertSubscription.bind(store);
      const spy = vi.spyOn(store, 'upsertSubscription').mockRejectedValueOnce(new Error('connection reset'));
      expect((await handle(post(body))).status).toBe(500);
      expect((await store.health(NOW)).lastFailureReason).toBe('store_error');
      spy.mockImplementation(real);
      expect((await handle(post(body))).status).toBe(200);
      expect(await store.getSubscription(loadFixture('subscription.created').data.id)).not.toBeNull();
    });

    it('total store outage → 500 and a log line, no throw', async () => {
      const dead = new Proxy(store, { get: () => async () => { throw new Error('down'); } }) as Store;
      const h = createWebhookHandler({ store: dead, secret: SECRET, toleranceSeconds: 5, log: (e) => logs.push(e), now: () => NOW });
      expect((await h(post(body))).status).toBe(500);
      expect(logs).toContainEqual(expect.objectContaining({ level: 'error', reason: 'store_error' }));
    });

    it('never logs the body, header or secret', async () => {
      await handle(post(body, sign(body, 'wrong', nowSec)));
      const text = JSON.stringify(logs);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('user_1');
      expect(text).not.toContain('h1=');
    });
  });
});
```

- [ ] **Step 2: Write the failing billing tests**

`tests/billing.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBilling } from '../src/core/billing';
import { memoryStore } from '../src/memory';
import { sign } from './helpers/sign';
import { loadFixture, subscriptionEvent } from './helpers/fixtures';

const base = () => ({ environment: 'sandbox' as const, webhookSecret: 's', store: memoryStore(), entitlements: { pri_pro: ['pro'] } });

describe('createBilling guards', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('throws without a webhook secret', () => {
    expect(() => createBilling({ ...base(), webhookSecret: undefined })).toThrow(/webhookSecret/);
    expect(() => createBilling({ ...base(), webhookSecret: '' })).toThrow(/webhookSecret/);
  });
  it('refuses production outside NODE_ENV=production unless explicitly allowed', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(() => createBilling({ ...base(), environment: 'production' })).toThrow(/production/);
    expect(() => createBilling({ ...base(), environment: 'production', allowProductionInDev: true })).not.toThrow();
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => createBilling({ ...base(), environment: 'production' })).not.toThrow();
  });
});

describe('hasAccess end to end through the webhook', () => {
  it('flips from false to true when a mapped subscription arrives', async () => {
    const fixture = loadFixture('subscription.created');
    const priceId = fixture.data.items[0].price.id;
    const now = new Date();
    const billing = createBilling({ ...base(), webhookSecret: 'sec', entitlements: { [priceId]: ['pro'] }, now: () => now });
    expect(await billing.hasAccess('user_1', 'pro')).toBe(false);
    const body = JSON.stringify(subscriptionEvent({ data: { status: 'active' } }));
    const res = await billing.handleWebhook(new Request('https://x/', { method: 'POST', headers: { 'paddle-signature': sign(body, 'sec', Math.floor(now.getTime() / 1000)) }, body }));
    expect(res.status).toBe(200);
    expect(await billing.hasAccess('user_1', 'pro')).toBe(true);
    expect(await billing.hasAccess('', 'pro')).toBe(false);
  });
});

describe('handleHealth', () => {
  it('404 when no healthToken is configured', async () => {
    expect((await createBilling(base()).handleHealth(new Request('https://x/'))).status).toBe(404);
  });
  it('401 with a wrong token, 200 with the right one', async () => {
    const b = createBilling({ ...base(), healthToken: 'tok' });
    expect((await b.handleHealth(new Request('https://x/', { headers: { authorization: 'Bearer nope' } }))).status).toBe(401);
    const ok = await b.handleHealth(new Request('https://x/', { headers: { authorization: 'Bearer tok' } }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ lastEventAt: null, failedLast24h: 0 });
  });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `npx vitest run tests/handler.test.ts tests/billing.test.ts`
Expected: FAIL — cannot resolve `../src/core/handler` / `../src/core/billing`.

- [ ] **Step 4: Implement the handler**

`src/core/handler.ts`:

```ts
import { nextPastDueSince } from './access';
import { parseEvent, type NormalisedEvent } from './events';
import { verifySignature } from './signature';
import type { EventStatus, Logger, ReasonCode, Store } from './types';

export interface HandlerDeps {
  store: Store;
  secret: string;
  toleranceSeconds: number;
  log: Logger;
  now: () => Date;
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function createWebhookHandler(d: HandlerDeps): (req: Request) => Promise<Response> {
  async function reject(reason: ReasonCode, status: number): Promise<Response> {
    d.log({ level: 'warn', reason });
    try {
      await d.store.recordFailure(reason, d.now());
    } catch {
      d.log({ level: 'error', reason: 'store_error' });
    }
    return json({ error: reason }, status);
  }

  async function apply(ev: NormalisedEvent): Promise<{ status: EventStatus; reason: ReasonCode | null }> {
    switch (ev.kind) {
      case 'subscription': {
        const prev = await d.store.getSubscription(ev.subscription.subscriptionId);
        const pastDueSince = nextPastDueSince(prev, ev.subscription.status, ev.occurredAt);
        const { applied } = await d.store.upsertSubscription({ ...ev.subscription, pastDueSince });
        if (!applied) return { status: 'stale', reason: 'out_of_order' };
        return { status: 'processed', reason: ev.subscription.userId ? null : 'no_user_id' };
      }
      case 'customer': {
        const { applied } = await d.store.upsertCustomer(ev.customer);
        return applied ? { status: 'processed', reason: null } : { status: 'stale', reason: 'out_of_order' };
      }
      case 'record-only':
        return { status: 'processed', reason: null };
      case 'ignored':
        return { status: 'ignored', reason: 'unknown_event' };
    }
  }

  return async function handle(req: Request): Promise<Response> {
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const rawBody = await req.text();
    if (!rawBody) return reject('missing_body', 400);

    const verified = await verifySignature({
      rawBody,
      header: req.headers.get('paddle-signature'),
      secret: d.secret,
      toleranceSeconds: d.toleranceSeconds,
      now: d.now().getTime(),
    });
    if (!verified.ok) return reject(verified.reason, verified.reason === 'bad_signature_header' ? 400 : 401);

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return reject('bad_json', 400);
    }
    const ev = parseEvent(parsed);
    if (!ev) return reject('bad_payload', 400);

    const tag = { eventId: ev.eventId, eventType: ev.eventType };
    try {
      const { alreadyDone } = await d.store.recordEvent({ ...tag, occurredAt: ev.occurredAt, receivedAt: d.now().toISOString() });
      if (alreadyDone) return json({ received: true, duplicate: true }, 200);
      const outcome = await apply(ev);
      await d.store.markEvent(ev.eventId, outcome.status, outcome.reason);
      if (outcome.reason && outcome.reason !== 'unknown_event') d.log({ level: 'warn', reason: outcome.reason, ...tag });
      return json({ received: true }, 200);
    } catch {
      d.log({ level: 'error', reason: 'store_error', ...tag });
      try {
        await d.store.markEvent(ev.eventId, 'failed', 'store_error');
      } catch {
        try {
          await d.store.recordFailure('store_error', d.now());
        } catch {
          /* store fully down: the log line above is the only record */
        }
      }
      return json({ error: 'store_error' }, 500);
    }
  };
}
```

Note for the implementer: the "store failure → retry succeeds" test relies on `recordEvent` returning `alreadyDone: false` for an event left in `failed` — that is the contract from Task 4, do not special-case it here.

- [ ] **Step 5: Implement the billing facade**

`src/core/billing.ts`:

```ts
import { decideAccess } from './access';
import { createWebhookHandler } from './handler';
import type { Health, Logger, ReasonCode, Store, Subscription } from './types';

export interface BillingConfig {
  environment: 'sandbox' | 'production';
  webhookSecret: string | undefined;
  store: Store;
  entitlements: Record<string, readonly string[]>;
  pastDueGraceDays?: number;
  signatureToleranceSeconds?: number;
  healthToken?: string;
  allowProductionInDev?: boolean;
  log?: Logger;
  now?: () => Date;
}

export interface Billing {
  config: Readonly<BillingConfig>;
  store: Store;
  log: Logger;
  handleWebhook(req: Request): Promise<Response>;
  handleHealth(req: Request): Promise<Response>;
  hasAccess(userId: string, feature: string): Promise<boolean>;
  getSubscriptions(userId: string): Promise<Subscription[]>;
  health(): Promise<Health>;
  recordFailure(reason: ReasonCode): Promise<void>;
}

const defaultLog: Logger = (entry) => console[entry.level](JSON.stringify({ source: 'paddle-kit', ...entry }));

export function createBilling(config: BillingConfig): Billing {
  if (!config.webhookSecret) throw new Error('paddle-kit: webhookSecret is required');
  const nodeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NODE_ENV;
  if (config.environment === 'production' && nodeEnv !== 'production' && !config.allowProductionInDev) {
    throw new Error('paddle-kit: environment "production" outside NODE_ENV=production; pass allowProductionInDev: true if intended');
  }
  const now = config.now ?? (() => new Date());
  const log = config.log ?? defaultLog;
  const policy = { entitlements: config.entitlements, pastDueGraceDays: config.pastDueGraceDays ?? 7 };
  const handleWebhook = createWebhookHandler({
    store: config.store,
    secret: config.webhookSecret,
    toleranceSeconds: config.signatureToleranceSeconds ?? 5,
    log,
    now,
  });

  return {
    config,
    store: config.store,
    log,
    handleWebhook,
    async handleHealth(req) {
      if (!config.healthToken) return new Response(null, { status: 404 });
      if (req.headers.get('authorization') !== `Bearer ${config.healthToken}`) return new Response(null, { status: 401 });
      return Response.json(await config.store.health(now()));
    },
    async hasAccess(userId, feature) {
      if (!userId) return false;
      return decideAccess(await config.store.getSubscriptionsByUser(userId), feature, policy, now());
    },
    getSubscriptions: (userId) => config.store.getSubscriptionsByUser(userId),
    health: () => config.store.health(now()),
    async recordFailure(reason) {
      log({ level: 'warn', reason });
      try {
        await config.store.recordFailure(reason, now());
      } catch {
        log({ level: 'error', reason: 'store_error' });
      }
    },
  };
}
```

`src/core/index.ts`:

```ts
export * from './types';
export * from './signature';
export * from './events';
export * from './access';
export * from './handler';
export * from './billing';
```

- [ ] **Step 6: Run to see them pass**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all suites PASS. Print the drill's test names in the report (`npx vitest run tests/handler.test.ts --reporter=verbose`).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): webhook handler, billing facade and failure drill

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Postgres store + migrations

**Files:**
- Create: `src/postgres/migrations.ts`, `src/postgres/index.ts`, `migrations/001_init.sql`, `tests/postgres-store.test.ts`

**Interfaces:**
- Consumes: `Store` contract (T4), `runStoreContract`.
- Produces: `SqlQuery = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>`, `postgresStore(opts: { query: SqlQuery }): Store`, `MIGRATIONS: ReadonlyArray<{ name: string; sql: string }>`.

Driver note for the README (Task 9): `pg.Pool#query`, `@neondatabase/serverless` `Pool#query` and PGlite's `db.query` already match `SqlQuery`. Neon's HTTP `neon()` needs `{ fullResults: true }` so it returns `{ rows }`.

- [ ] **Step 1: Write the failing tests**

`tests/postgres-store.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { MIGRATIONS, postgresStore } from '../src/postgres';
import { createBilling } from '../src/core/billing';
import { sign } from './helpers/sign';
import { subscriptionEvent } from './helpers/fixtures';
import { runStoreContract } from './helpers/store-contract';

async function freshDb() {
  const db = new PGlite();
  for (const m of MIGRATIONS) await db.exec(m.sql);
  return db;
}

runStoreContract('postgres (PGlite)', async () => {
  const db = await freshDb();
  return postgresStore({ query: (text, params) => db.query(text, params) as any });
});

it('migrations/001_init.sql is byte-identical to MIGRATIONS[0]', () => {
  expect(readFileSync(new URL('../migrations/001_init.sql', import.meta.url), 'utf8')).toBe(MIGRATIONS[0]!.sql);
});

it('migrations are additive: only CREATE statements on paddle_ tables', () => {
  for (const m of MIGRATIONS) {
    expect(m.sql).not.toMatch(/\b(DROP|ALTER|TRUNCATE|DELETE)\b/i);
    for (const t of m.sql.matchAll(/CREATE (?:TABLE|INDEX)(?: IF NOT EXISTS)? (\w+)/gi)) expect(t[1]).toMatch(/^paddle_/);
  }
});

it('out-of-order + duplicate deliveries converge in real Postgres', async () => {
  const db = await freshDb();
  const now = new Date('2026-10-15T12:00:00Z');
  const billing = createBilling({
    environment: 'sandbox', webhookSecret: 'sec', entitlements: {},
    store: postgresStore({ query: (t, p) => db.query(t, p) as any }), now: () => now, log: () => {},
  });
  const ts = Math.floor(now.getTime() / 1000);
  const send = (b: unknown) => {
    const body = JSON.stringify(b);
    return billing.handleWebhook(new Request('https://x/', { method: 'POST', headers: { 'paddle-signature': sign(body, 'sec', ts) }, body }));
  };
  const created = subscriptionEvent({ eventId: 'c', occurredAt: '2026-10-15T10:00:00Z', data: { status: 'active' } });
  const updated = subscriptionEvent({ eventId: 'u', eventType: 'subscription.updated', occurredAt: '2026-10-15T11:00:00Z', data: { status: 'paused' } });
  for (const e of [updated, created, updated, created]) expect((await send(e)).status).toBe(200);
  const rows = (await db.query<{ status: string }>('SELECT status FROM paddle_subscriptions')).rows;
  expect(rows).toEqual([{ status: 'paused' }]);
  const evs = (await db.query<{ event_id: string; status: string }>('SELECT event_id, status FROM paddle_events ORDER BY event_id')).rows;
  expect(evs).toEqual([{ event_id: 'c', status: 'stale' }, { event_id: 'u', status: 'processed' }]);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/postgres-store.test.ts`
Expected: FAIL — cannot resolve `../src/postgres`.

- [ ] **Step 3: Implement migrations**

`src/postgres/migrations.ts` (the SQL string must end with a single newline):

```ts
export const MIGRATIONS: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: '001_init',
    sql: `CREATE TABLE IF NOT EXISTS paddle_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  status text NOT NULL,
  reason text
);
CREATE INDEX IF NOT EXISTS paddle_events_received_at_idx ON paddle_events (received_at);

CREATE TABLE IF NOT EXISTS paddle_failures (
  bucket timestamptz NOT NULL,
  reason text NOT NULL,
  hits integer NOT NULL,
  last_at timestamptz NOT NULL,
  PRIMARY KEY (bucket, reason)
);

CREATE TABLE IF NOT EXISTS paddle_customers (
  customer_id text PRIMARY KEY,
  email text,
  last_event_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paddle_subscriptions (
  subscription_id text PRIMARY KEY,
  customer_id text NOT NULL,
  user_id text,
  status text NOT NULL,
  price_ids jsonb NOT NULL,
  current_period_end timestamptz,
  scheduled_change jsonb,
  canceled_at timestamptz,
  past_due_since timestamptz,
  last_event_at timestamptz NOT NULL,
  raw jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paddle_subscriptions_user_id_idx ON paddle_subscriptions (user_id);
`,
  },
];
```

Then write `migrations/001_init.sql` with exactly that SQL (generate it so it cannot drift):

```bash
npx tsx -e "import('./src/postgres/migrations.ts').then(m => process.stdout.write(m.MIGRATIONS[0].sql))" > migrations/001_init.sql
```


- [ ] **Step 4: Implement the store**

`src/postgres/index.ts`:

```ts
import type { EventStatus, Health, ReasonCode, Store, Subscription } from '../core/types';

export { MIGRATIONS } from './migrations';

export type SqlQuery = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string | Date).toISOString());
const jsonParam = (v: unknown) => (v == null ? null : JSON.stringify(v));
const DAY_MS = 86_400_000;

function toSubscription(r: Record<string, unknown>): Subscription {
  return {
    subscriptionId: r.subscription_id as string,
    customerId: r.customer_id as string,
    userId: (r.user_id as string | null) ?? null,
    status: r.status as Subscription['status'],
    priceIds: r.price_ids as string[],
    currentPeriodEnd: iso(r.current_period_end),
    scheduledChange: (r.scheduled_change as Subscription['scheduledChange']) ?? null,
    canceledAt: iso(r.canceled_at),
    pastDueSince: iso(r.past_due_since),
    lastEventAt: iso(r.last_event_at)!,
    raw: r.raw,
  };
}

export function postgresStore({ query }: { query: SqlQuery }): Store {
  return {
    async recordEvent(e) {
      const { rows } = await query(
        `INSERT INTO paddle_events (event_id, event_type, occurred_at, received_at, status)
         VALUES ($1, $2, $3, $4, 'received')
         ON CONFLICT (event_id) DO UPDATE SET event_id = paddle_events.event_id -- no-op so RETURNING yields the stored row
         RETURNING status`,
        [e.eventId, e.eventType, e.occurredAt, e.receivedAt],
      );
      const status = rows[0]?.status as EventStatus;
      return { alreadyDone: status === 'processed' || status === 'ignored' || status === 'stale' };
    },
    async markEvent(eventId, status, reason) {
      await query(`UPDATE paddle_events SET status = $2, reason = $3 WHERE event_id = $1`, [eventId, status, reason]);
    },
    async recordFailure(reason, at) {
      await query(
        `INSERT INTO paddle_failures (bucket, reason, hits, last_at)
         VALUES (date_trunc('minute', $1::timestamptz), $2, 1, $1::timestamptz)
         ON CONFLICT (bucket, reason) DO UPDATE
           SET hits = paddle_failures.hits + 1, last_at = GREATEST(paddle_failures.last_at, EXCLUDED.last_at)`,
        [at.toISOString(), reason],
      );
    },
    async upsertCustomer(c) {
      const { rows } = await query(
        `INSERT INTO paddle_customers (customer_id, email, last_event_at) VALUES ($1, $2, $3)
         ON CONFLICT (customer_id) DO UPDATE
           SET email = EXCLUDED.email, last_event_at = EXCLUDED.last_event_at, updated_at = now()
           WHERE paddle_customers.last_event_at <= EXCLUDED.last_event_at
         RETURNING customer_id`,
        [c.customerId, c.email, c.lastEventAt],
      );
      return { applied: rows.length > 0 };
    },
    async upsertSubscription(s) {
      const { rows } = await query(
        `INSERT INTO paddle_subscriptions
           (subscription_id, customer_id, user_id, status, price_ids, current_period_end, scheduled_change,
            canceled_at, past_due_since, last_event_at, raw)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10, $11::jsonb)
         ON CONFLICT (subscription_id) DO UPDATE SET
           customer_id = EXCLUDED.customer_id,
           user_id = COALESCE(EXCLUDED.user_id, paddle_subscriptions.user_id),
           status = EXCLUDED.status,
           price_ids = EXCLUDED.price_ids,
           current_period_end = EXCLUDED.current_period_end,
           scheduled_change = EXCLUDED.scheduled_change,
           canceled_at = EXCLUDED.canceled_at,
           past_due_since = EXCLUDED.past_due_since,
           last_event_at = EXCLUDED.last_event_at,
           raw = EXCLUDED.raw,
           updated_at = now()
         WHERE paddle_subscriptions.last_event_at <= EXCLUDED.last_event_at
         RETURNING subscription_id`,
        [
          s.subscriptionId, s.customerId, s.userId, s.status, jsonParam(s.priceIds), s.currentPeriodEnd,
          jsonParam(s.scheduledChange), s.canceledAt, s.pastDueSince, s.lastEventAt, jsonParam(s.raw ?? {}),
        ],
      );
      return { applied: rows.length > 0 };
    },
    async getSubscription(id) {
      const { rows } = await query(`SELECT * FROM paddle_subscriptions WHERE subscription_id = $1`, [id]);
      return rows[0] ? toSubscription(rows[0]) : null;
    },
    async getSubscriptionsByUser(userId) {
      const { rows } = await query(`SELECT * FROM paddle_subscriptions WHERE user_id = $1 ORDER BY last_event_at DESC`, [userId]);
      return rows.map(toSubscription);
    },
    async health(now): Promise<Health> {
      const since = new Date(now.getTime() - DAY_MS).toISOString();
      const until = now.toISOString();
      const { rows: [agg] } = await query(
        `SELECT
           (SELECT max(received_at) FROM paddle_events WHERE status IN ('processed','ignored','stale')) AS last_event_at,
           (SELECT count(*)::int FROM paddle_events WHERE status = 'failed' AND received_at > $1 AND received_at <= $2) AS failed_events,
           (SELECT coalesce(sum(hits), 0)::int FROM paddle_failures WHERE last_at > $1 AND bucket <= $2) AS failed_requests,
           (SELECT count(*)::int FROM paddle_events WHERE reason = 'no_user_id' AND received_at > $1 AND received_at <= $2) AS unlinked`,
        [since, until],
      );
      const { rows: [last] } = await query(
        `SELECT at, reason FROM (
           SELECT received_at AS at, reason FROM paddle_events WHERE status = 'failed'
           UNION ALL
           SELECT last_at AS at, reason FROM paddle_failures
         ) f ORDER BY at DESC LIMIT 1`,
      );
      return {
        lastEventAt: iso(agg?.last_event_at),
        lastFailureAt: iso(last?.at),
        lastFailureReason: (last?.reason as ReasonCode | undefined) ?? null,
        failedLast24h: Number(agg?.failed_events ?? 0) + Number(agg?.failed_requests ?? 0),
        unlinkedLast24h: Number(agg?.unlinked ?? 0),
      };
    },
  };
}
```

Known approximation (document in README): `failedLast24h` counts a whole minute-bucket if its latest hit is in the window.

- [ ] **Step 5: Run to see it pass**

Run: `npx vitest run tests/postgres-store.test.ts && npx tsc --noEmit`
Expected: PASS — the same contract suite as memory, plus the three Postgres-only tests. A contract failure means the Postgres store is wrong; never edit the shared contract to make one store pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(postgres): Postgres store with additive migrations, tested on PGlite

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Framework adapters (Next, Hono, Express)

**Files:**
- Create: `src/next/index.ts`, `src/hono/index.ts`, `src/express/index.ts`, `tests/adapters.test.ts`

**Interfaces:**
- Consumes: `Billing` (T4).
- Produces: `createNextRoute(billing: Billing): { POST(req: Request): Promise<Response>; GET(req: Request): Promise<Response> }`; `paddleWebhook(billing)` and `paddleHealth(billing)` for Hono (`(c: Context) => Promise<Response>`); `paddleWebhook(billing)` for Express (`(req, res) => Promise<void>`, requires `express.raw()` before it).

- [ ] **Step 1: Write the failing tests**

`tests/adapters.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import express from 'express';
import { Hono } from 'hono';
import type { AddressInfo } from 'node:net';
import { createBilling } from '../src/core/billing';
import { memoryStore } from '../src/memory';
import { createNextRoute } from '../src/next';
import { paddleWebhook as honoWebhook } from '../src/hono';
import { paddleWebhook as expressWebhook } from '../src/express';
import type { LogEntry } from '../src/core/types';
import { sign } from './helpers/sign';
import { subscriptionEvent } from './helpers/fixtures';

const body = JSON.stringify(subscriptionEvent({ eventId: 'evt_adapter' }));
const makeBilling = (logs: LogEntry[] = []) =>
  createBilling({ environment: 'sandbox', webhookSecret: 'sec', store: memoryStore(), entitlements: {}, healthToken: 't', log: (e) => logs.push(e) });
const headers = () => ({ 'content-type': 'application/json', 'paddle-signature': sign(body, 'sec') });

async function withServer(app: express.Express, fn: (url: string) => Promise<void>) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

describe('next adapter', () => {
  it('POST verifies and stores; GET serves health', async () => {
    const route = createNextRoute(makeBilling());
    expect((await route.POST(new Request('https://x/', { method: 'POST', headers: headers(), body }))).status).toBe(200);
    expect((await route.GET(new Request('https://x/', { headers: { authorization: 'Bearer t' } }))).status).toBe(200);
  });
});

describe('hono adapter', () => {
  it('passes the untouched raw body through', async () => {
    const app = new Hono().post('/paddle', honoWebhook(makeBilling()));
    expect((await app.request('/paddle', { method: 'POST', headers: headers(), body })).status).toBe(200);
  });
});

describe('express adapter', () => {
  it('works behind express.raw()', async () => {
    const app = express();
    app.post('/paddle', express.raw({ type: '*/*' }), expressWebhook(makeBilling()));
    await withServer(app, async (url) => {
      const res = await fetch(`${url}/paddle`, { method: 'POST', headers: headers(), body });
      expect(res.status).toBe(200);
    });
  });

  it('fails loudly when express.json() already parsed the body', async () => {
    const logs: LogEntry[] = [];
    const billing = makeBilling(logs);
    const app = express();
    app.use(express.json());
    app.post('/paddle', expressWebhook(billing));
    await withServer(app, async (url) => {
      const res = await fetch(`${url}/paddle`, { method: 'POST', headers: headers(), body });
      expect(res.status).toBe(500);
    });
    expect(logs).toContainEqual(expect.objectContaining({ reason: 'missing_raw_body' }));
    expect((await billing.health()).lastFailureReason).toBe('missing_raw_body');
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/adapters.test.ts`
Expected: FAIL — cannot resolve the adapter modules.

- [ ] **Step 3: Implement**

`src/next/index.ts`:

```ts
import type { Billing } from '../core/billing';

/** App Router: `export const { POST, GET } = createNextRoute(billing);` in app/api/paddle/route.ts */
export function createNextRoute(billing: Billing) {
  return {
    POST: (req: Request) => billing.handleWebhook(req),
    GET: (req: Request) => billing.handleHealth(req),
  };
}
```

`src/hono/index.ts`:

```ts
import type { Context } from 'hono';
import type { Billing } from '../core/billing';

export function paddleWebhook(billing: Billing) {
  return (c: Context) => billing.handleWebhook(c.req.raw);
}

export function paddleHealth(billing: Billing) {
  return (c: Context) => billing.handleHealth(c.req.raw);
}
```

`src/express/index.ts`:

```ts
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import type { Billing } from '../core/billing';

/** Mount as: app.post('/paddle', express.raw({ type: '*\/*' }), paddleWebhook(billing)) */
export function paddleWebhook(billing: Billing) {
  return async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
    if (!Buffer.isBuffer(req.body)) {
      await billing.recordFailure('missing_raw_body');
      res.status(500).json({ error: 'missing_raw_body' });
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(', '));
    }
    const response = await billing.handleWebhook(
      new Request(`http://localhost${req.originalUrl}`, { method: req.method, headers, body: req.body }),
    );
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.send(await response.text());
  };
}
```

- [ ] **Step 4: Run to see it pass**

Run: `npx vitest run tests/adapters.test.ts && npx tsc --noEmit`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(adapters): Next, Hono and Express webhook adapters

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Checkout helper + reconcile

**Files:**
- Create: `src/client/index.ts`, `src/reconcile/index.ts`, `tests/client.test.ts`, `tests/reconcile.test.ts`

**Interfaces:**
- Consumes: `Billing`, `Subscription`, `nextPastDueSince`.
- Produces:
  - `createCheckout(cfg: { token: string; environment: 'sandbox' | 'production' }): Promise<{ open(o: CheckoutOptions): void }>`, `CheckoutOptions { priceId: string; userId: string; email?: string; successUrl?: string; quantity?: number }`.
  - `SdkSubscriptionLike` (the camelCase fields read from the SDK entity), `fromSdkSubscription(s: SdkSubscriptionLike): Omit<Subscription, 'pastDueSince'>`, `reconcile(billing: Billing, opts: { apiKey: string; client?: { subscriptions: { list(): AsyncIterable<SdkSubscriptionLike> } } }): Promise<{ scanned: number; applied: number }>`.

- [ ] **Step 1: Write the failing tests**

`tests/client.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { open, initializePaddle } = vi.hoisted(() => {
  const open = vi.fn();
  return { open, initializePaddle: vi.fn(async () => ({ Checkout: { open } })) };
});
vi.mock('@paddle/paddle-js', () => ({ initializePaddle }));

import { createCheckout } from '../src/client';

describe('createCheckout', () => {
  beforeEach(() => { open.mockClear(); initializePaddle.mockClear(); });

  it('passes userId as customData so the webhook can link the subscription', async () => {
    const checkout = await createCheckout({ token: 'test_abc', environment: 'sandbox' });
    checkout.open({ priceId: 'pri_1', userId: 'user_1', email: 'a@x.com', successUrl: 'https://app/ok' });
    expect(initializePaddle).toHaveBeenCalledWith({ token: 'test_abc', environment: 'sandbox' });
    expect(open).toHaveBeenCalledWith({
      items: [{ priceId: 'pri_1', quantity: 1 }],
      customer: { email: 'a@x.com' },
      customData: { userId: 'user_1' },
      settings: { successUrl: 'https://app/ok' },
    });
  });

  it('refuses to open without a userId', async () => {
    const checkout = await createCheckout({ token: 'test_abc', environment: 'sandbox' });
    expect(() => checkout.open({ priceId: 'pri_1', userId: '' })).toThrow(/userId/);
  });

  it.each([
    ['test_abc', 'production'],
    ['live_abc', 'sandbox'],
  ] as const)('rejects token %s with environment %s', async (token, environment) => {
    await expect(createCheckout({ token, environment })).rejects.toThrow(/token/);
  });
});
```

`tests/reconcile.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createBilling } from '../src/core/billing';
import { memoryStore } from '../src/memory';
import { reconcile, type SdkSubscriptionLike } from '../src/reconcile';

const sdkSub = (o: Partial<SdkSubscriptionLike> = {}): SdkSubscriptionLike => ({
  id: 'sub_1', status: 'active', customerId: 'ctm_1', items: [{ price: { id: 'pri_pro' } }],
  currentBillingPeriod: { endsAt: '2026-11-01T00:00:00.000Z' }, scheduledChange: null,
  customData: { userId: 'user_1' }, canceledAt: null, updatedAt: '2026-10-14T00:00:00.000Z', ...o,
});
const client = (subs: SdkSubscriptionLike[]) => ({ subscriptions: { list: async function* () { yield* subs; } } });
const billing = () => createBilling({ environment: 'sandbox', webhookSecret: 's', store: memoryStore(), entitlements: { pri_pro: ['pro'] } });

describe('reconcile', () => {
  it('fills a missing subscription so access is correct after missed webhooks', async () => {
    const b = billing();
    expect(await reconcile(b, { apiKey: 'pdl_sdbx_apikey_x', client: client([sdkSub()]) })).toEqual({ scanned: 1, applied: 1 });
    expect(await b.hasAccess('user_1', 'pro')).toBe(true);
  });

  it('never overwrites newer webhook state with an older API snapshot', async () => {
    const b = billing();
    await b.store.upsertSubscription({
      subscriptionId: 'sub_1', customerId: 'ctm_1', userId: 'user_1', status: 'canceled', priceIds: ['pri_pro'],
      currentPeriodEnd: null, scheduledChange: null, canceledAt: '2026-10-15T00:00:00.000Z', pastDueSince: null,
      lastEventAt: '2026-10-15T00:00:00.000Z', raw: {},
    });
    expect(await reconcile(b, { apiKey: 'pdl_sdbx_apikey_x', client: client([sdkSub()]) })).toEqual({ scanned: 1, applied: 0 });
    expect(await b.hasAccess('user_1', 'pro')).toBe(false);
  });

  it('rejects a live key against a sandbox billing', async () => {
    await expect(reconcile(billing(), { apiKey: 'pdl_live_apikey_x', client: client([]) })).rejects.toThrow(/environment/);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/client.test.ts tests/reconcile.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/client/index.ts`:

```ts
import { initializePaddle } from '@paddle/paddle-js';

export interface CheckoutOptions {
  priceId: string;
  userId: string;
  email?: string;
  successUrl?: string;
  quantity?: number;
}

export async function createCheckout(cfg: { token: string; environment: 'sandbox' | 'production' }) {
  const tokenEnv = cfg.token.startsWith('test_') ? 'sandbox' : cfg.token.startsWith('live_') ? 'production' : null;
  if (tokenEnv !== cfg.environment) {
    throw new Error(`paddle-kit: client token does not match environment "${cfg.environment}"`);
  }
  const paddle = await initializePaddle({ token: cfg.token, environment: cfg.environment });
  if (!paddle) throw new Error('paddle-kit: Paddle.js failed to initialise');
  return {
    open(o: CheckoutOptions): void {
      if (!o.userId) throw new Error('paddle-kit: userId is required so the subscription can be linked to the user');
      paddle.Checkout.open({
        items: [{ priceId: o.priceId, quantity: o.quantity ?? 1 }],
        customer: o.email ? { email: o.email } : undefined,
        customData: { userId: o.userId },
        settings: o.successUrl ? { successUrl: o.successUrl } : undefined,
      });
    },
  };
}
```

If `tsc` rejects `customer: undefined` / `settings: undefined` against Paddle.js's types, build the options object conditionally instead and keep the test's expected object identical.

`src/reconcile/index.ts`:

```ts
import { Environment, Paddle } from '@paddle/paddle-node-sdk';
import { nextPastDueSince } from '../core/access';
import type { Billing } from '../core/billing';
import type { Subscription } from '../core/types';

export interface SdkSubscriptionLike {
  id: string;
  status: string;
  customerId: string;
  items: Array<{ price?: { id?: string } | null }>;
  currentBillingPeriod?: { endsAt?: string | null } | null;
  scheduledChange?: { action: string; effectiveAt: string } | null;
  customData?: Record<string, unknown> | null;
  canceledAt?: string | null;
  updatedAt: string;
}

export function fromSdkSubscription(s: SdkSubscriptionLike): Omit<Subscription, 'pastDueSince'> {
  const userId = s.customData?.userId;
  return {
    subscriptionId: s.id,
    customerId: s.customerId,
    userId: typeof userId === 'string' && userId ? userId : null,
    status: s.status as Subscription['status'],
    priceIds: s.items.map((i) => i.price?.id).filter((id): id is string => !!id),
    currentPeriodEnd: s.currentBillingPeriod?.endsAt ?? null,
    scheduledChange: s.scheduledChange ? { action: s.scheduledChange.action, effectiveAt: s.scheduledChange.effectiveAt } : null,
    canceledAt: s.canceledAt ?? null,
    // updatedAt, not "now": a webhook that occurred after this snapshot must still win.
    lastEventAt: s.updatedAt,
    raw: s,
  };
}

export async function reconcile(
  billing: Billing,
  opts: { apiKey: string; client?: { subscriptions: { list(): AsyncIterable<SdkSubscriptionLike> } } },
): Promise<{ scanned: number; applied: number }> {
  const keyEnv = opts.apiKey.startsWith('pdl_sdbx_') ? 'sandbox' : opts.apiKey.startsWith('pdl_live_') ? 'production' : null;
  if (keyEnv !== billing.config.environment) {
    throw new Error(`paddle-kit: API key does not match environment "${billing.config.environment}"`);
  }
  const client =
    opts.client ??
    (new Paddle(opts.apiKey, {
      environment: billing.config.environment === 'production' ? Environment.production : Environment.sandbox,
    }) as unknown as { subscriptions: { list(): AsyncIterable<SdkSubscriptionLike> } });

  let scanned = 0;
  let applied = 0;
  for await (const raw of client.subscriptions.list()) {
    scanned++;
    const sub = fromSdkSubscription(raw);
    const prev = await billing.store.getSubscription(sub.subscriptionId);
    const result = await billing.store.upsertSubscription({ ...sub, pastDueSince: nextPastDueSince(prev, sub.status, sub.lastEventAt) });
    if (result.applied) applied++;
  }
  return { scanned, applied };
}
```

Before relying on the cast: open `node_modules/@paddle/paddle-node-sdk/dist/types` and confirm `paddle.subscriptions.list()` returns an async-iterable collection whose items expose the fields in `SdkSubscriptionLike` (Paddle's own `subscription-sync` skill iterates it with `for await`). If the shape differs, adapt `fromSdkSubscription`, not the test's intent, and say so in the report.

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run tests/client.test.ts tests/reconcile.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: Paddle.js checkout helper and API reconcile

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Edge-runtime proof, package smoke test, README

**Files:**
- Create: `tests/edge.test.ts`, `scripts/check-edge.mjs`, `scripts/smoke-pack.mjs`, `README.md`

**Interfaces:**
- Consumes: everything above. Produces: `npm run check:edge`, `npm run smoke`.

- [ ] **Step 1: Edge-runtime test**

`tests/edge.test.ts`:

```ts
// @vitest-environment edge-runtime
import { expect, it } from 'vitest';
import { createBilling } from '../src/core/billing';
import { memoryStore } from '../src/memory';

it('verifies, stores and grants access inside the edge runtime', async () => {
  const body = JSON.stringify({
    event_id: 'evt_edge', event_type: 'subscription.created', occurred_at: '2026-10-15T00:00:00Z',
    data: { id: 'sub_e', status: 'active', customer_id: 'ctm_e', items: [{ price: { id: 'pri_pro' } }], custom_data: { userId: 'u' } },
  });
  const ts = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('sec'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}:${body}`)));
  const h1 = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  const billing = createBilling({ environment: 'sandbox', webhookSecret: 'sec', store: memoryStore(), entitlements: { pri_pro: ['pro'] } });
  const res = await billing.handleWebhook(new Request('https://x/', { method: 'POST', headers: { 'paddle-signature': `ts=${ts};h1=${h1}` }, body }));
  expect(res.status).toBe(200);
  expect(await billing.hasAccess('u', 'pro')).toBe(true);
});
```

(This file signs with WebCrypto because `node:crypto` is unavailable in the edge env; the independent `node:crypto` signer is already exercised in Tasks 1 and 6.)

- [ ] **Step 2: Static check of the built edge-safe bundles**

`scripts/check-edge.mjs`:

```js
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const EDGE_SAFE = ['core', 'memory', 'postgres', 'next', 'hono'];
const files = readdirSync('dist', { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.js'))
  .filter((f) => EDGE_SAFE.some((d) => f.startsWith(`${d}/`)) || /^chunk-.*\.js$/.test(f));
let bad = 0;
for (const f of files) {
  const src = readFileSync(join('dist', f), 'utf8');
  for (const pattern of [/from\s+["']node:/, /require\(/, /\bBuffer\b/, /\bprocess\.(?!env)/]) {
    if (pattern.test(src)) {
      console.error(`EDGE VIOLATION ${f}: ${pattern}`);
      bad++;
    }
  }
}
if (files.length === 0) {
  console.error('no dist files found — run npm run build first');
  process.exit(1);
}
console.log(`checked ${files.length} files, ${bad} violations`);
process.exit(bad ? 1 : 0);
```

Limitation to state in the report: this scan plus the edge-runtime test cover API use, not every edge host's quirks; a deploy to one real edge target remains UNVERIFIED until Task 11.

- [ ] **Step 3: Pack-and-import smoke test**

`scripts/smoke-pack.mjs`:

```js
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tgz = execFileSync('npm', ['pack', '--silent'], { encoding: 'utf8' }).trim().split('\n').at(-1);
const dir = mkdtempSync(join(tmpdir(), 'paddle-kit-smoke-'));
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'smoke', type: 'module', private: true }));
execFileSync('npm', ['i', '--silent', resolve(tgz), '@paddle/paddle-node-sdk@3.10.0', '@paddle/paddle-js', 'hono', 'express'], { cwd: dir, stdio: 'inherit' });
const subpaths = ['core', 'memory', 'postgres', 'next', 'hono', 'express', 'client', 'reconcile'];
const code = subpaths.map((p) => `await import('paddle-kit/${p}');`).join('\n') + "\nconsole.log('all subpaths import');";
writeFileSync(join(dir, 'check.mjs'), code);
execFileSync('node', ['check.mjs'], { cwd: dir, stdio: 'inherit' });
```

- [ ] **Step 4: README**

`README.md` must contain, in this order: what it is (2 lines); install (`npm i github:SnaxxTech/paddle-kit#v0.1.0`); env vars (`PADDLE_ENV`, `PADDLE_NOTIFICATION_WEBHOOK_SECRET`, `PADDLE_API_KEY` for reconcile only, `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`); run the migration (`MIGRATIONS` or `migrations/001_init.sql`); a complete Next.js example (`lib/billing.ts` with `postgresStore` over `@neondatabase/serverless` `Pool`, `app/api/paddle/route.ts` with `createNextRoute`, a client button calling `createCheckout(...).open(...)`, a server component calling `hasAccess`); Hono and Express snippets (Express: `express.raw` warning); which Paddle events to subscribe the destination to (the spec §4 list); monitoring (`healthToken`, what each `Health` field means, Paddle's retry windows: live 60 attempts / ~3 days, sandbox 3 / ~15 min; run `reconcile` from an existing cron after any outage); the `failedLast24h` minute-bucket approximation; the Kosovo payout note from the spec; and "not for in-app purchases in store-distributed mobile apps".

- [ ] **Step 5: Run everything**

Run: `npx tsc --noEmit && npx vitest run && npm run build && npm run check:edge && npm run smoke`
Expected: all green; `check:edge` prints `0 violations`; smoke prints `all subpaths import`. Report the vitest totals line verbatim.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: edge-runtime proof, packed-import smoke test, README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Release mechanics (no push without the owner)

**Files:**
- Create: `scripts/release.sh`

- [ ] **Step 1: Write the release script**

`scripts/release.sh`:

```bash
#!/usr/bin/env bash
# Builds dist/ into a detached release commit and tags it, so consumers can
# `npm i github:SnaxxTech/paddle-kit#vX.Y.Z` without a build step, while main stays dist-free.
set -euo pipefail
version="${1:?usage: scripts/release.sh 0.1.0}"
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean"; exit 1; }
start="$(git rev-parse --abbrev-ref HEAD)"
npx tsc --noEmit
npx vitest run
npm run build
npm run check:edge
git checkout --detach
git add -f dist
git commit -m "release v${version}"
git tag "v${version}"
git checkout "$start"
echo "Tagged v${version}. Push is a separate, owner-approved step: git push origin v${version}"
```

```bash
chmod +x scripts/release.sh
```

- [ ] **Step 2: Dry run locally**

Run: `scripts/release.sh 0.1.0 && git show --stat v0.1.0 | head -20 && git status --short`
Expected: tag `v0.1.0` exists and its commit contains `dist/`; `main` is checked out again with a clean tree and no `dist/` tracked.

- [ ] **Step 3: Commit the script**

```bash
git add scripts/release.sh
git commit -m "chore: tag releases with built dist on a detached commit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: STOP — owner gate**

Creating `SnaxxTech/paddle-kit` on GitHub (private) and pushing `main` + `v0.1.0` is outward-facing. Ask the owner; on yes:

```bash
gh repo create SnaxxTech/paddle-kit --private --source . --push
git push origin v0.1.0
```

---

### Task 11: Sandbox end-to-end acceptance (owner-assisted)

Needs: a Paddle sandbox account with one product + monthly price, a client-side token, a sandbox API key, a notification destination; the owner sets the sandbox key in the plugin (`claude plugin configure paddle@claude-community`, interactive) — agents never paste keys.

- [ ] **Step 1:** In offday (proposed consumer; owner confirms), on a branch: install from the tag, run `001_init.sql` on a Neon **branch** (not main DB), wire `lib/billing.ts`, `app/api/paddle/route.ts`, a Subscribe button and a page that prints `hasAccess(user, 'pro')`.
- [ ] **Step 2:** Tunnel (`hookdeck listen 3000` or `ngrok http 3000`), point the sandbox destination at `/api/paddle`, subscribe it to the spec §4 events.
- [ ] **Step 3:** Pay with `4242 4242 4242 4242`. Expected evidence: `paddle_events` rows for `customer.created`, `transaction.completed`, `subscription.created` all `processed`; `paddle_subscriptions.user_id` = the logged-in user; the page flips to `pro: true`. This is also the first real confirmation that checkout `customData` reaches `subscription.custom_data` — record the actual payload field.
- [ ] **Step 4:** Cancel immediately via the simulator or API. Expected: `subscription.canceled` processed; page shows `pro: false`.
- [ ] **Step 5:** Drill on the real destination: change `PADDLE_NOTIFICATION_WEBHOOK_SECRET` to a wrong value, re-run a simulation. Expected: Paddle's notification log shows the failed delivery, `/api/paddle` GET (with token) shows `lastFailureReason: "signature_mismatch"`; restore the secret, Paddle's retry succeeds.
- [ ] **Step 6:** Run `reconcile` against sandbox once; expected `applied: 0` (state already current).
- [ ] **Step 7:** Owner reviews the evidence (rows, health JSON, screenshots of the page before/after). Only then is v0.1 accepted.
