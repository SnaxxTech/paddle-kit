import { describe, expect, it } from 'vitest';
import * as config from '../src/config';
import type { FetchLike } from '../src/core/paddle-api';
import { memoryStore } from '../src/memory';
import * as server from '../src/server';
import { createCheckoutTransaction, customerPortalSession } from '../src/server';
import { runReadmeBlock } from './helpers/readme-blocks';

// Server-created checkout and the customer portal (since v0.8.4). The server decides the user, the items and which
// prices may be sold; the browser only opens the checkout for the transaction id it is handed.
type Call = { method: string; url: string; body: any; auth: string | undefined };

function paddle(answer: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.Authorization };
    calls.push(call);
    const { status = 200, body } = answer(call);
    return { ok: status < 300, status, json: async () => body };
  };
  return { fetch, calls };
}

const api = (fetch: FetchLike) => ({ apiKey: 'pdl_sdbx_apikey_secretvalue', environment: 'sandbox' as const, fetch });

describe('createCheckoutTransaction', () => {
  const ok = () => ({ status: 201, body: { data: { id: 'txn_01abc', status: 'draft', checkout: { url: 'https://kiwii.test/pay?_ptxn=txn_01abc' } } } });

  it('creates an automatic transaction with userId set by the server, and returns its id', async () => {
    const p = paddle(ok);
    const r = await createCheckoutTransaction(api(p.fetch), {
      userId: 'ws_1', items: [{ priceId: 'pri_m', quantity: 1 }], customerId: 'ctm_1',
      customData: { userId: 'attacker', orderRef: 'o-7' }, allowedPriceIds: ['pri_m', 'pri_y'],
    });
    expect(r).toEqual({ transactionId: 'txn_01abc', checkoutUrl: 'https://kiwii.test/pay?_ptxn=txn_01abc' });
    expect(p.calls).toEqual([{
      method: 'POST', url: 'https://sandbox-api.paddle.com/transactions', auth: 'Bearer pdl_sdbx_apikey_secretvalue',
      body: { items: [{ price_id: 'pri_m', quantity: 1 }], customer_id: 'ctm_1', collection_mode: 'automatic', custom_data: { orderRef: 'o-7', userId: 'ws_1' } },
    }]);
  });

  it('refuses before calling Paddle: no user, no items, a bad quantity, a price that is not for sale', async () => {
    const p = paddle(ok);
    const create = (o: any) => createCheckoutTransaction(api(p.fetch), o);
    await expect(create({ userId: '', items: [{ priceId: 'pri_m', quantity: 1 }] })).rejects.toThrow('userId is required');
    await expect(create({ userId: 'u', items: [] })).rejects.toThrow('at least one item');
    await expect(create({ userId: 'u', items: [{ priceId: 'pri_m', quantity: 0 }] })).rejects.toThrow('quantity');
    await expect(create({ userId: 'u', items: [{ priceId: 'pri_m', quantity: 1.5 }] })).rejects.toThrow('quantity');
    await expect(create({ userId: 'u', items: [{ priceId: 'pri_old', quantity: 1 }], allowedPriceIds: ['pri_m'] })).rejects.toThrow('pri_old is not for sale');
    expect(p.calls).toEqual([]);
  });

  it('a Paddle error is a PaddleError with the status and code, never the key', async () => {
    const p = paddle(() => ({ status: 400, body: { error: { code: 'transaction_price_not_found', detail: 'pdl_sdbx_apikey_secretvalue nope' } } }));
    const err = await createCheckoutTransaction(api(p.fetch), { userId: 'u', items: [{ priceId: 'pri_x', quantity: 1 }] }).catch((e) => e);
    expect(err.name).toBe('PaddleError');
    expect(err.status).toBe(400);
    expect(err.message).toContain('transaction_price_not_found');
    expect(err.message).not.toContain('secretvalue');
  });

  it('an answer without a txn_ id is refused', async () => {
    const p = paddle(() => ({ body: { data: { id: 'nope' } } }));
    await expect(createCheckoutTransaction(api(p.fetch), { userId: 'u', items: [{ priceId: 'pri_m', quantity: 1 }] })).rejects.toThrow('no transaction id');
  });
});

describe('customerPortalSession', () => {
  const portal = (overview: string, sub = 'https://sandbox-customer-portal.paddle.com/cpl_1/sub') => ({
    status: 201,
    body: { data: { urls: { general: { overview }, subscriptions: [{ id: 'sub_1', cancel_subscription: sub, update_subscription_payment_method: sub }] } } },
  });

  it('returns the overview and per-subscription links, for the customer and subscriptions asked', async () => {
    const p = paddle(() => portal('https://sandbox-customer-portal.paddle.com/cpl_1'));
    const r = await customerPortalSession(api(p.fetch), { customerId: 'ctm_1', subscriptionIds: ['sub_1'] });
    expect(r).toEqual({
      overview: 'https://sandbox-customer-portal.paddle.com/cpl_1',
      subscriptions: { sub_1: { cancel: 'https://sandbox-customer-portal.paddle.com/cpl_1/sub', updatePaymentMethod: 'https://sandbox-customer-portal.paddle.com/cpl_1/sub' } },
    });
    expect(p.calls[0]).toMatchObject({ method: 'POST', url: 'https://sandbox-api.paddle.com/customers/ctm_1/portal-sessions', body: { subscription_ids: ['sub_1'] } });
  });

  it('never hands the browser a link outside Paddle\'s portal', async () => {
    for (const bad of ['https://evil.example/cpl_1', 'http://sandbox-customer-portal.paddle.com/cpl_1', 'https://customer-portal.paddle.com.evil.example/x']) {
      const p = paddle(() => portal(bad));
      await expect(customerPortalSession(api(p.fetch), { customerId: 'ctm_1' })).rejects.toThrow('not a Paddle customer portal link');
    }
    const p = paddle(() => portal('https://sandbox-customer-portal.paddle.com/cpl_1', 'https://evil.example/x'));
    await expect(customerPortalSession(api(p.fetch), { customerId: 'ctm_1', subscriptionIds: ['sub_1'] })).rejects.toThrow('not a Paddle customer portal link');
  });

  it('a live key gets the live portal host; a customer id that is not ctm_ is refused before calling Paddle', async () => {
    const p = paddle(() => portal('https://customer-portal.paddle.com/cpl_9'));
    const r = await customerPortalSession({ apiKey: 'pdl_live_k', environment: 'production', fetch: p.fetch }, { customerId: 'ctm_9' });
    expect(r.overview).toBe('https://customer-portal.paddle.com/cpl_9');
    expect(p.calls[0]!.url).toBe('https://api.paddle.com/customers/ctm_9/portal-sessions');
    const q = paddle(() => portal('x'));
    await expect(customerPortalSession(api(q.fetch), { customerId: '../transactions' })).rejects.toThrow('customerId');
    expect(q.calls).toEqual([]);
  });
});

describe('README: app/billing/actions.ts, run as written', () => {
  async function setup(user: { id: string } | null) {
    const p = paddle((call) => call.url.endsWith('/transactions')
      ? { status: 201, body: { data: { id: 'txn_01readme', checkout: { url: null } } } }
      : { status: 201, body: { data: { urls: { general: { overview: 'https://sandbox-customer-portal.paddle.com/cpl_r' }, subscriptions: [] } } } });
    const store = memoryStore();
    const lib = config.billingFromEnv({
      PADDLE_ENV: 'sandbox', PADDLE_NOTIFICATION_WEBHOOK_SECRET: 'pdl_ntfset_r', NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: 'test_r',
      PADDLE_PRICES: JSON.stringify({ pro: { monthly: 'pri_m', yearly: 'pri_y' } }), PADDLE_API_KEY: 'pdl_sdbx_readme',
    }, { store, log: () => {}, products: { pro: { features: ['pro'], retiredPriceIds: ['pri_old'] } }, paddleFetch: p.fetch });
    await store.upsertSubscription({ subscriptionId: 'sub_r', customerId: 'ctm_r', userId: 'u1', status: 'active', priceIds: ['pri_m'], currentPeriodEnd: null, scheduledChange: null, canceledAt: null, pastDueSince: null, lastEventAt: '2026-11-03T00:00:00.000Z', raw: {} });
    const actions = runReadmeBlock('`app/billing/actions.ts`', {
      'paddle-kit/server': server, '@/lib/billing': lib, '@/lib/session': { currentUser: async () => user },
    });
    return { actions, calls: p.calls };
  }

  it('startCheckout: the session user and the price on sale, chosen on the server', async () => {
    const t = await setup({ id: 'u1' });
    expect(await t.actions.startCheckout('yearly')).toBe('txn_01readme');
    expect(t.calls[0]!.body).toEqual({ items: [{ price_id: 'pri_y', quantity: 1 }], collection_mode: 'automatic', custom_data: { userId: 'u1' } });
  });

  it('portalLink: the customer from the store, the overview link back', async () => {
    const t = await setup({ id: 'u1' });
    expect(await t.actions.portalLink()).toBe('https://sandbox-customer-portal.paddle.com/cpl_r');
    expect(t.calls[0]).toMatchObject({ url: 'https://sandbox-api.paddle.com/customers/ctm_r/portal-sessions', body: { subscription_ids: ['sub_r'] } });
  });

  it('signed out: both refuse before calling Paddle', async () => {
    const t = await setup(null);
    await expect(t.actions.startCheckout('monthly')).rejects.toThrow('sign in first');
    await expect(t.actions.portalLink()).rejects.toThrow('sign in first');
    expect(t.calls).toEqual([]);
  });
});

describe('cancelSubscription (since v0.9.2)', () => {
  it('cancels immediately by default, refuses an id that is not sub_…, and never sends the key elsewhere', async () => {
    const { cancelSubscription } = await import('../src/server');
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetch = async (url: string, init: { body?: string }) => {
      calls.push({ url, body: JSON.parse(init.body ?? '{}') });
      return { ok: true, status: 200, json: async () => ({ data: { id: 'sub_01abc', status: 'canceled' } }) };
    };
    const api = { apiKey: 'pdl_sdbx_apikey_test0000000000000', environment: 'sandbox' as const, fetch: fetch as any };
    expect(await cancelSubscription(api, 'sub_01abc')).toEqual({ status: 'canceled' });
    expect(calls).toEqual([{ url: 'https://sandbox-api.paddle.com/subscriptions/sub_01abc/cancel', body: { effective_from: 'immediately' } }]);
    await expect(cancelSubscription(api, '../customers/ctm_1')).rejects.toThrow('sub_');
    expect(calls).toHaveLength(1);
  });
});

describe('cancelSubscription is idempotent (since v0.9.2)', () => {
  const api = (fetch: unknown) => ({ apiKey: 'pdl_sdbx_apikey_test0000000000000', environment: 'sandbox' as const, fetch: fetch as any });
  const answer = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
  it('an already canceled subscription is a success, not an error', async () => {
    const { cancelSubscription } = await import('../src/server');
    const fetch = async (url: string, init: { method: string }) => init.method === 'POST'
      ? answer(400, { error: { code: 'subscription_locked', detail: 'canceled' } })
      : answer(200, { data: { id: 'sub_01abc', status: 'canceled' } });
    expect(await cancelSubscription(api(fetch), 'sub_01abc')).toEqual({ status: 'canceled' });
  });
  it('any other refusal still throws (the webhook fails and Paddle retries)', async () => {
    const { cancelSubscription } = await import('../src/server');
    const fetch = async (url: string, init: { method: string }) => init.method === 'POST'
      ? answer(400, { error: { code: 'bad_request', detail: 'nope' } })
      : answer(200, { data: { id: 'sub_01abc', status: 'active' } });
    await expect(cancelSubscription(api(fetch), 'sub_01abc')).rejects.toThrow('400');
  });
});
