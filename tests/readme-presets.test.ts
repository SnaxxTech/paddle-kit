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
    expect(h.checks.migrations).toEqual({ ok: true, detail: 'partly checked: the store has no checkSchema' }); // memoryStore
  });
});

describe('preset: a one-time unlock (README "Example: a one-time unlock": wiring, webhook, canUse, on PGlite)', () => {
  const SECRET = 'pdl_ntfset_unlock';
  const env = {
    PADDLE_ENV: 'sandbox', PADDLE_NOTIFICATION_WEBHOOK_SECRET: SECRET, NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: 'test_unlock',
    PADDLE_PRICES: JSON.stringify({ lifetime: 'pri_life' }),
  };
  const dbs: PGlite[] = [];
  afterEach(async () => { await Promise.all(dbs.splice(0).map((d) => d.close())); });

  async function setup() {
    const pg = new PGlite();
    dbs.push(pg);
    await pg.exec(readmeSqlAfter('### Example: a one-time unlock'));
    const db = { transaction: <T>(fn: (q: any) => Promise<T>) => pg.transaction((t) => fn(t)), query: (text: string, params?: unknown[]) => pg.query(text, params) };
    const unlocks = runReadmeBlock('### Example: a one-time unlock', { 'paddle-kit/core': core }, { db });
    vi.stubGlobal('process', { ...process, env });
    // The README's wiring block, as written; its free names are the Quickstart's imports and pool.
    const lib = runReadmeBlock('Wire it in `lib/billing.ts`', {}, {
      billingFromEnv: config.billingFromEnv, priceIdOf: config.priceIdOf, unlockHooks: unlocks.unlockHooks,
      postgresStore: () => memoryStore(), pool: { query: async () => ({ rows: [] }) },
    });
    const policy = runReadmeBlock('`lib/policy.ts` with unlocks', { '@/lib/billing': lib, '@/lib/unlocks': unlocks });
    let n = 0;
    const deliver = async (payload: unknown) => {
      const body = JSON.stringify(payload);
      return (await lib.billing.handleWebhook(new Request('https://app.test/api/paddle', { method: 'POST', headers: { 'paddle-signature': sign(body, SECRET) }, body }))).status;
    };
    const payment = (txn: string, price: string, userId: string | null = 'u1') => {
      const raw = JSON.parse(readFileSync(new URL('./fixtures/transaction.completed.json', import.meta.url), 'utf8'));
      raw.event_id = `evt_${txn}_${++n}`;
      raw.data.id = txn;
      raw.data.subscription_id = null;
      raw.data.custom_data = userId ? { userId } : null;
      raw.data.items = [{ ...raw.data.items[0], price: { ...raw.data.items[0].price, id: price }, quantity: 1 }];
      return raw;
    };
    const ctx = { eventId: 'e', eventType: 't', store: {} as any, known: true };
    const hooks = unlocks.unlockHooks({ pri_life: 'pro' });
    const adjust = (adjustmentId: string, transactionId: string, action: string, status: string, type: 'full' | 'partial' = 'full') =>
      hooks.onAdjustment({ adjustmentId, transactionId, action, status, type, subscriptionId: null, customerId: null, currency: 'USD', total: '4900', subtotal: '4900', occurredAt: '', raw: {} } as Adjustment, ctx);
    const canUse = () => policy.canUse('u1', 'pro') as Promise<boolean>;
    const reviews = async () => (await pg.query<{ transaction_id: string; reason: string }>('SELECT transaction_id, reason FROM unlock_reviews ORDER BY transaction_id')).rows;
    return { pg, deliver, payment, adjust, canUse, reviews };
  }

  it('a signed payment unlocks through canUse; a replay adds nothing; a refund locks and its reversal unlocks', async () => {
    const t = await setup();
    expect(await t.canUse()).toBe(false);
    expect(await t.deliver(t.payment('txn_1', 'pri_life'))).toBe(200);
    expect(await t.canUse()).toBe(true);
    expect(await t.deliver(t.payment('txn_1', 'pri_life'))).toBe(200); // a replay with a new event id
    expect((await t.pg.query('SELECT count(*)::int AS n FROM unlocks')).rows).toEqual([{ n: 1 }]);
    await t.adjust('adj_p', 'txn_1', 'refund', 'approved', 'partial');
    expect(await t.canUse()).toBe(true);
    await t.adjust('adj_f', 'txn_1', 'refund', 'approved');
    expect(await t.canUse()).toBe(false);
    await t.adjust('adj_f', 'txn_1', 'refund', 'reversed');
    expect(await t.canUse()).toBe(true);
  });

  it('a refund that arrived before its payment keeps it locked', async () => {
    const t = await setup();
    await t.adjust('adj_r', 'txn_1', 'refund', 'approved');
    expect(await t.deliver(t.payment('txn_1', 'pri_life'))).toBe(200);
    expect(await t.canUse()).toBe(false);
  });

  it('a paid order with no user or a price that unlocks nothing stays visible for a person, once', async () => {
    const t = await setup();
    expect(await t.deliver(t.payment('txn_nouser', 'pri_life', null))).toBe(200);
    expect(await t.deliver(t.payment('txn_nouser', 'pri_life', null))).toBe(200);
    // Owned (it is in PADDLE_PRICES) but mapped to no feature by a stale map: kept for review too.
    const hooks = runReadmeBlock('### Example: a one-time unlock', { 'paddle-kit/core': core }, {
      db: { transaction: <T>(fn: (q: any) => Promise<T>) => t.pg.transaction((x) => fn(x)), query: (q: string, p?: unknown[]) => t.pg.query(q, p) },
    }).unlockHooks({});
    await hooks.onTransaction({ transactionId: 'txn_unmapped', status: 'completed', customerId: null, subscriptionId: null, customData: { userId: 'u1' }, items: [{ priceId: 'pri_life', productId: null, quantity: 1 }], currency: 'USD', total: '4900', subtotal: '4900', occurredAt: '', raw: {} } as Transaction, { eventId: 'e', eventType: 't', store: {} as any, known: true });
    expect(await t.reviews()).toEqual([
      { transaction_id: 'txn_nouser', reason: 'no_user' },
      { transaction_id: 'txn_unmapped', reason: 'unknown_price' },
    ]);
    expect(await t.canUse()).toBe(false);
  });
});

describe('preset: credit packs through paddle-kit/fulfil (README lib/credits.ts, on PGlite)', () => {
  const opened: PGlite[] = [];
  afterEach(async () => { await Promise.all(opened.splice(0).map((d) => d.close())); });

  async function setup() {
    const { MIGRATIONS } = await import('../src/postgres');
    const fulfil = await import('../src/fulfil');
    const pg = new PGlite();
    opened.push(pg);
    for (const m of MIGRATIONS) await pg.exec(m.sql);
    await pg.exec('CREATE TABLE accounts (user_id text PRIMARY KEY, credits int NOT NULL CHECK (credits >= 0))');
    const db = { transaction: <T>(fn: (q: any) => Promise<T>) => pg.transaction((t) => fn(t)) };
    const block = runReadmeBlock('\n`lib/credits.ts`\n', { 'paddle-kit/fulfil': fulfil }, { db });
    const hooks = block.creditPack('pri_pack');
    const ctx = { eventId: 'e', eventType: 't', store: {} as any, known: true };
    const pay = (id: string, quantity = 1) => hooks.onTransaction({ transactionId: id, status: 'completed', customerId: null, subscriptionId: null, customData: { userId: 'u1' }, items: [{ priceId: 'pri_pack', productId: null, quantity }], currency: 'USD', total: '1500', subtotal: '1500', occurredAt: '', raw: {} } as Transaction, ctx);
    const adjust = (adjustmentId: string, transactionId: string, action: string, status: string) =>
      hooks.onAdjustment({ adjustmentId, transactionId, action, status, type: 'full', subscriptionId: null, customerId: null, currency: 'USD', total: '1500', subtotal: '1500', occurredAt: '', raw: {} } as Adjustment, ctx);
    const balance = async () => (await pg.query<{ credits: number }>(`SELECT credits FROM accounts WHERE user_id = 'u1'`)).rows[0]?.credits ?? 0;
    return { pg, pay, adjust, balance };
  }

  it('grants by quantity once, queues one receipt; buy 5, spend 3, refund, reverse = 2; a refund first grants nothing', async () => {
    const t = await setup();
    await t.pay('txn_1', 2);
    await t.pay('txn_1', 2);
    expect(await t.balance()).toBe(10);
    expect((await t.pg.query('SELECT id FROM paddle_outbox')).rows).toEqual([{ id: 'txn_1:receipt' }]);
    await t.pg.query(`UPDATE accounts SET credits = 7 WHERE user_id = 'u1'`); // 3 of 10 spent
    await t.adjust('adj_r', 'txn_1', 'refund', 'approved');
    expect(await t.balance()).toBe(0);
    await t.adjust('adj_r', 'txn_1', 'refund', 'reversed');
    expect(await t.balance()).toBe(7);
    await t.adjust('adj_r2', 'txn_2', 'refund', 'approved');
    await t.pay('txn_2');
    expect(await t.balance()).toBe(7);
  });
});
