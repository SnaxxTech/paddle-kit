import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as config from '../src/config';
import * as core from '../src/core';
import type { Adjustment, Transaction } from '../src/core';
import { memoryStore } from '../src/memory';
import { readmeSqlAfter, runReadmeBlock } from './helpers/readme-blocks';
import { sign } from './helpers/sign';

// The Quickstart's presets, end to end, from the blocks of README.md as written.
afterEach(() => vi.unstubAllGlobals());

describe('preset: a subscription (Quickstart lib/billing.ts + lib/policy.ts)', () => {
  const SECRET = 'pdl_ntfset_preset';
  const env = {
    PADDLE_ENV: 'sandbox', PADDLE_NOTIFICATION_WEBHOOK_SECRET: SECRET, NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: 'test_preset',
    PADDLE_PRICES: JSON.stringify({ pro: { monthly: 'pri_m', yearly: 'pri_y' } }),
  };
  class Pool { query = async () => ({ rows: [] }); }

  function app(extra: Record<string, string> = {}) {
    vi.stubGlobal('process', { ...process, env: { ...env, ...extra } });
    const lib = runReadmeBlock('\n`lib/billing.ts`\n', {
      '@neondatabase/serverless': { Pool }, 'paddle-kit/config': config, 'paddle-kit/postgres': { postgresStore: () => memoryStore() },
    });
    const policy = runReadmeBlock('\n`lib/policy.ts`\n', { '@/lib/billing': lib });
    return { lib, canUse: policy.canUse as (u: string | null, f: string) => Promise<boolean> };
  }

  const event = (type: string, status: string, price: string, n: number) => {
    const raw = JSON.parse(readFileSync(new URL('./fixtures/subscription.created.json', import.meta.url), 'utf8'));
    raw.event_id = `evt_preset_${n}`;
    raw.event_type = type;
    raw.occurred_at = new Date(Date.UTC(2026, 10, 3, 12, n)).toISOString();
    raw.data.status = status;
    raw.data.custom_data = { userId: 'u1' };
    raw.data.items = raw.data.items.slice(0, 1).map((i: any) => ({ ...i, price: { ...i.price, id: price } }));
    if (status === 'canceled') raw.data.canceled_at = raw.occurred_at;
    return raw;
  };
  const deliver = async (lib: any, payload: unknown) => {
    const body = JSON.stringify(payload);
    return lib.billing.handleWebhook(new Request('https://app.test/api/paddle', { method: 'POST', headers: { 'paddle-signature': sign(body, SECRET) }, body }));
  };

  it('a subscription on the yearly price gives the feature; cancelling takes it away', async () => {
    const { lib, canUse } = app();
    expect(await canUse('u1', 'pro')).toBe(false);
    expect((await deliver(lib, event('subscription.created', 'active', 'pri_y', 1))).status).toBe(200);
    expect(await canUse('u1', 'pro')).toBe(true);
    expect(await canUse('u2', 'pro')).toBe(false);
    expect((await deliver(lib, event('subscription.canceled', 'canceled', 'pri_y', 2))).status).toBe(200);
    expect(await canUse('u1', 'pro')).toBe(false);
  });

  it('billing off is free only while not enforced; a broken env with enforcement refuses', async () => {
    vi.stubGlobal('process', { ...process, env: {} });
    const off = runReadmeBlock('\n`lib/policy.ts`\n', { '@/lib/billing': { billing: null, enforce: false } });
    expect(await off.canUse('u1', 'pro')).toBe(true);
    const enforced = runReadmeBlock('\n`lib/policy.ts`\n', { '@/lib/billing': { billing: null, enforce: true } });
    expect(await enforced.canUse('u1', 'pro')).toBe(false);
  });

  it('the readiness checks are in its health report', async () => {
    const { lib } = app({ PADDLE_HEALTH_TOKEN: 'h'.repeat(20) });
    vi.stubGlobal('fetch', async () => Response.json({ error: {} }, { status: 403 }));
    const res = await lib.billing.handleHealth(new Request('https://app.test/', { headers: { authorization: `Bearer ${'h'.repeat(20)}` } }));
    const h = (await res.json()) as { checks: Record<string, { ok: boolean; detail?: string }> };
    expect(h.checks.paddle_api_key).toEqual({ ok: false, detail: 'PADDLE_API_KEY is missing' });
    expect(h.checks.cron_secret).toEqual({ ok: false, detail: 'CRON_SECRET is missing' });
    expect(h.checks.migrations).toEqual({ ok: true });
  });
});

describe('preset: a one-time unlock (README "Example: a one-time unlock", on PGlite)', () => {
  async function setup() {
    const pg = new PGlite();
    await pg.exec(readmeSqlAfter('### Example: a one-time unlock'));
    const db = { transaction: <T>(fn: (q: any) => Promise<T>) => pg.transaction((t) => fn(t)), query: (text: string, params?: unknown[]) => pg.query(text, params) };
    const block = runReadmeBlock('### Example: a one-time unlock', { 'paddle-kit/core': core }, { db });
    const hooks = block.unlockHooks({ pri_life: 'pro' });
    const ctx = { eventId: 'e', eventType: 't', store: {} as any, known: true };
    const pay = (id: string, price = 'pri_life') => hooks.onTransaction({ transactionId: id, status: 'completed', customerId: null, subscriptionId: null, customData: { userId: 'u1' }, items: [{ priceId: price, productId: null, quantity: 1 }], currency: 'USD', total: '4900', subtotal: '4900', occurredAt: '', raw: {} } as Transaction, ctx);
    const adjust = (adjustmentId: string, transactionId: string, action: string, status: string, type: 'full' | 'partial' = 'full') =>
      hooks.onAdjustment({ adjustmentId, transactionId, action, status, type, subscriptionId: null, customerId: null, currency: 'USD', total: '4900', subtotal: '4900', occurredAt: '', raw: {} } as Adjustment, ctx);
    const has = () => block.hasUnlock('u1', 'pro') as Promise<boolean>;
    return { pg, pay, adjust, has };
  }

  it('a payment unlocks; a replay changes nothing; a refund locks and its reversal unlocks', async () => {
    const t = await setup();
    expect(await t.has()).toBe(false);
    await t.pay('txn_1');
    await t.pay('txn_1');
    expect(await t.has()).toBe(true);
    expect((await t.pg.query('SELECT count(*)::int AS n FROM unlocks')).rows).toEqual([{ n: 1 }]);
    await t.adjust('adj_r', 'txn_1', 'refund', 'approved', 'partial');
    expect(await t.has()).toBe(true);
    await t.adjust('adj_f', 'txn_1', 'refund', 'approved');
    expect(await t.has()).toBe(false);
    await t.adjust('adj_f', 'txn_1', 'refund', 'reversed');
    expect(await t.has()).toBe(true);
  });

  it('a refund that arrived before its payment keeps it locked; an unknown price unlocks nothing', async () => {
    const t = await setup();
    await t.adjust('adj_r', 'txn_1', 'refund', 'approved');
    await t.pay('txn_1');
    expect(await t.has()).toBe(false);
    await t.pay('txn_2', 'pri_other');
    expect(await t.has()).toBe(false);
  });
});
