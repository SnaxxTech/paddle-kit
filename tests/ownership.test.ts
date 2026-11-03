import { describe, expect, it } from 'vitest';
import { billingFromEnv } from '../src/config';
import type { FetchLike } from '../src/core/paddle-api';
import { memoryStore } from '../src/memory';
import { recoverBilling, syncOwnership } from '../src/reconcile';
import { sign } from './helpers/sign';

// Historical ownership (v0.8.0): with prices found by label, a late payment on a price the app no longer sells
// (archived or replaced) is still ours. Ownership is decided from ids kept in the app's own store, never by asking
// Paddle in the webhook path.
const SECRET = 'pdl_ntfset_owned';
const KEY = 'pdl_sdbx_owned_key';
const NOW = new Date('2026-11-03T12:00:00Z');
const env = { PADDLE_ENV: 'sandbox', PADDLE_NOTIFICATION_WEBHOOK_SECRET: SECRET, NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: 'test_owned', PADDLE_API_KEY: KEY };

const product = (id: string, app: string, status = 'active') => ({ id, status, custom_data: { paddle_kit: app } });
const price = (id: string, label: string | null, prod: ReturnType<typeof product>, status = 'active') => ({
  id, status, name: label, billing_cycle: null, unit_price: { amount: '1500', currency_code: 'USD' },
  custom_data: label ? { paddle_kit_price: label } : null, product: prod,
});
const ours = product('pro_demo', 'demo');
const retired = product('pro_demo_v1', 'demo', 'archived');
const catalog = [
  price('pri_new', 'pack-once', ours),
  price('pri_old', 'pack-once', ours, 'archived'), // replaced by pri_new
  price('pri_v1', 'pack-once', retired, 'archived'), // a whole retired product
  price('pri_other', 'pack-once', product('pro_other', 'other')),
];

function fakePaddle() {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const statuses = (u.searchParams.get('status') ?? 'active').split(',');
    const data = u.pathname === '/prices' ? catalog.filter((p) => statuses.includes(p.status)) : [];
    return { ok: true, status: 200, json: async () => ({ data, meta: { pagination: { has_more: false } } }) };
  };
  return { fetch, calls };
}

function setup() {
  const paddle = fakePaddle();
  const paid: string[] = [];
  const store = memoryStore();
  const { billing, config, problems } = billingFromEnv(env, {
    requiredPrices: ['pack'], resolvePrices: { app: 'demo', fetch: paddle.fetch }, store, now: () => NOW, log: () => {},
    onTransaction: (tx) => { paid.push(tx.transactionId); },
  });
  expect(problems).toEqual([]);
  const pay = async (priceId: string, productId: string) => {
    const body = JSON.stringify({
      event_id: `evt_${priceId}`, event_type: 'transaction.completed', occurred_at: NOW.toISOString(),
      data: { id: `txn_${priceId}`, status: 'completed', subscription_id: null, custom_data: null, items: [{ price: { id: priceId, product_id: productId }, quantity: 1 }] },
    });
    const res = await billing!.handleWebhook(new Request('https://app.test/', { method: 'POST', headers: { 'paddle-signature': sign(body, SECRET, Math.floor(NOW.getTime() / 1000)) }, body }));
    return { status: res.status, body: await res.json() };
  };
  return { billing: billing!, config: config as Extract<typeof config, { resolvePrices: unknown }>, paddle, paid, store, pay };
}

describe('historical ownership', () => {
  it('before any sync, an unknown price is retried (503), never acked not_ours, and Paddle is not asked', async () => {
    const t = setup();
    expect(await t.pay('pri_old', 'pro_demo')).toEqual({ status: 503, body: { error: 'prices_unavailable' } });
    expect(t.paddle.calls).toEqual([]);
    expect(t.paid).toEqual([]);
  });

  it('after the recovery job syncs, late payments on replaced and retired prices are fulfilled; another app\'s are not ours', async () => {
    const t = setup();
    expect(await recoverBilling(t.billing, { apiKey: KEY, fetch: t.paddle.fetch, now: () => NOW })).toMatchObject({ status: 'done' });
    t.paddle.calls.length = 0;
    expect((await t.pay('pri_old', 'pro_demo')).status).toBe(200);
    expect((await t.pay('pri_v1', 'pro_demo_v1')).status).toBe(200);
    expect((await t.pay('pri_unlisted', 'pro_demo')).status).toBe(200); // any price of our product
    expect((await t.pay('pri_other', 'pro_other')).status).toBe(200);
    expect(t.paid).toEqual(['txn_pri_old', 'txn_pri_v1', 'txn_pri_unlisted']);
    expect(t.paddle.calls).toEqual([]); // decided from the local store only
    // checkout still sees only what is on sale now
    expect(await t.config.resolvePrices()).toEqual({ pack: 'pri_new' });
  });

  it('syncOwnership keeps ids once owned: a later catalog without them never drops them', async () => {
    const t = setup();
    expect(await syncOwnership(t.billing, { apiKey: KEY, app: 'demo', fetch: t.paddle.fetch })).toEqual({ priceIds: 3, productIds: 2 });
    expect(await t.store.getOwnedIds!()).toEqual({ priceIds: ['pri_new', 'pri_old', 'pri_v1'], productIds: ['pro_demo', 'pro_demo_v1'] });
    await syncOwnership(t.billing, { apiKey: KEY, app: 'demo', fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [], meta: { pagination: { has_more: false } } }) }) });
    expect((await t.store.getOwnedIds!()).priceIds).toHaveLength(3);
  });
});
