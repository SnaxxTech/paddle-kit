import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createBilling } from '../src/core/billing';
import { memoryStore } from '../src/memory';
import { sign } from './helpers/sign';
import { loadFixture, subscriptionEvent } from './helpers/fixtures';
import * as signature from '../src/core/signature';

vi.mock('../src/core/signature', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/signature')>();
  return { ...real, constantTimeEqual: vi.fn(real.constantTimeEqual), safeEqual: vi.fn(real.safeEqual) };
});

const base = () => ({ environment: 'sandbox' as const, webhookSecret: 's', store: memoryStore(), entitlements: { pri_pro: ['pro'] } });

describe('createBilling guards', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('throws without a webhook secret', () => {
    expect(() => createBilling({ ...base(), webhookSecret: undefined })).toThrow(/webhookSecret/);
    expect(() => createBilling({ ...base(), webhookSecret: '' })).toThrow(/webhookSecret/);
    expect(() => createBilling({ ...base(), webhookSecret: [] })).toThrow(/webhookSecret/);
    expect(() => createBilling({ ...base(), webhookSecret: ['s', ''] })).toThrow(/webhookSecret/);
  });
  it('refuses production outside NODE_ENV=production unless explicitly allowed', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(() => createBilling({ ...base(), environment: 'production' })).toThrow(/production/);
    expect(() => createBilling({ ...base(), environment: 'production', allowProductionInDev: true })).not.toThrow();
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => createBilling({ ...base(), environment: 'production' })).not.toThrow();
  });
  it('allows production when no NODE_ENV is available, as on Workers', () => {
    const saved = (globalThis as any).process;
    try {
      (globalThis as any).process = undefined;
      expect(() => createBilling({ ...base(), environment: 'production' })).not.toThrow();
    } finally {
      (globalThis as any).process = saved;
    }
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
  it('reports the kit version and the environment, so one dashboard can show every app', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const b = createBilling({ ...base(), healthToken: 'tok' });
    const res = await b.handleHealth(new Request('https://x/', { headers: { authorization: 'Bearer tok' } }));
    expect(await res.json()).toMatchObject({ kitVersion: pkg.version, environment: base().environment });
  });
  it('compares the token with a length-independent constant-time compare (same and other length wrong token → 401)', async () => {
    const b = createBilling({ ...base(), healthToken: 'tok' });
    expect((await b.handleHealth(new Request('https://x/', { headers: { authorization: 'Bearer tox' } }))).status).toBe(401);
    expect((await b.handleHealth(new Request('https://x/', { headers: { authorization: 'Bearer to' } }))).status).toBe(401);
    expect((await b.handleHealth(new Request('https://x/'))).status).toBe(401);
    expect(signature.safeEqual).toHaveBeenCalledWith('Bearer tox', 'Bearer tok');
    expect(signature.safeEqual).toHaveBeenCalledWith('Bearer to', 'Bearer tok');
  });
  it('503 store_error (and logs) instead of throwing when the store is down', async () => {
    const logs: any[] = [];
    const store = { ...memoryStore(), health: async () => { throw new Error('db down'); } };
    const b = createBilling({ ...base(), store, healthToken: 'tok', log: (e) => logs.push(e) });
    const res = await b.handleHealth(new Request('https://x/', { headers: { authorization: 'Bearer tok' } }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'store_error' });
    expect(logs).toContainEqual({ level: 'error', reason: 'store_error' });
  });
});

describe('maxBodyBytes', () => {
  it('reaches the webhook handler', async () => {
    const b = createBilling({ ...base(), maxBodyBytes: 10 });
    const res = await b.handleWebhook(new Request('https://x/', { method: 'POST', body: '{"event_id":"evt_eleven"}' }));
    expect(res.status).toBe(413);
  });
});

describe('config exposure', () => {
  it('does not expose the webhook secret', () => {
    const billing = createBilling({ ...base(), webhookSecret: 'super-secret-value' });
    expect('webhookSecret' in billing.config).toBe(false);
    expect(JSON.stringify(billing.config)).not.toContain('super-secret-value');
  });
});

describe('transaction and adjustment hooks through createBilling', () => {
  it('wires onTransaction and onAdjustment into the webhook, with the billing store in the context', async () => {
    const now = new Date();
    const seen: string[] = [];
    const cfg = base();
    const billing = createBilling({
      ...cfg,
      webhookSecret: 'sec',
      now: () => now,
      onTransaction: (tx, ctx) => { seen.push(`tx:${tx.transactionId}:${ctx.store === cfg.store}`); },
      onAdjustment: (adj) => { seen.push(`adj:${adj.action}`); },
    });
    const post = (name: string) => {
      const body = JSON.stringify(loadFixture(name));
      return billing.handleWebhook(new Request('https://x/', { method: 'POST', headers: { 'paddle-signature': sign(body, 'sec', Math.floor(now.getTime() / 1000)) }, body }));
    };
    expect((await post('transaction.completed')).status).toBe(200);
    expect((await post('adjustment.created')).status).toBe(200);
    expect(seen).toEqual(['tx:txn_01hv8wptq8987qeep44cyrewp9:true', 'adj:refund']);
  });
});

const auth = { headers: { authorization: 'Bearer tok' } };
const signed = (body: string, secret: string, at: Date) =>
  new Request('https://x/', { method: 'POST', headers: { 'paddle-signature': sign(body, secret, Math.floor(at.getTime() / 1000)) }, body });

describe('health since v0.7.0', () => {
  it('unverified: refused requests are counted in memory and shown in health; the store holds none of them', async () => {
    const store = memoryStore();
    const b = createBilling({ ...base(), store, healthToken: 'tok', log: () => {} });
    await b.handleWebhook(new Request('https://x/', { method: 'POST', body: '{}' }));
    await b.handleWebhook(new Request('https://x/', { method: 'POST', body: '{}', headers: { 'paddle-signature': sign('{}', 'other') } }));
    const h = await (await b.handleHealth(new Request('https://x/', auth))).json();
    expect(h.unverified).toMatchObject({ count: 2, byReason: { bad_signature_header: 1, signature_mismatch: 1 }, lastReason: 'signature_mismatch' });
    expect(h).toMatchObject({ failedLast24h: 0, lastFailureReason: null });
    expect('checks' in h).toBe(false);
  });

  it('healthChecks: each runs, by name; a false, a throw, a timeout and a non-result are ok: false; onError gets the throw', async () => {
    const errors: unknown[] = [];
    const boom = new Error('price api down');
    const b = createBilling({
      ...base(), healthToken: 'tok', healthCheckTimeoutMs: 30, onError: (e, ctx) => void errors.push([e, ctx]),
      healthChecks: {
        price: async () => ({ ok: true, detail: 'paddle' }),
        fallback: () => ({ ok: false, detail: 'fallback: timeout' }),
        throws: async () => { throw boom; },
        hangs: () => new Promise(() => {}),
        junk: async () => 'yes' as any,
      },
    });
    const res = await b.handleHealth(new Request('https://x/', auth));
    expect(res.status).toBe(200);
    expect((await res.json()).checks).toEqual({
      price: { ok: true, detail: 'paddle' },
      fallback: { ok: false, detail: 'fallback: timeout' },
      throws: { ok: false, detail: 'threw an error' },
      hangs: { ok: false, detail: 'no answer in 30 ms' },
      junk: { ok: false, detail: 'returned no { ok } result' },
    });
    expect(errors).toContainEqual([boom, { reason: 'health_check', check: 'throws' }]);
    expect(JSON.stringify(await (await b.handleHealth(new Request('https://x/', auth))).json())).not.toContain('price api down');
  });

  it('healthChecks never run without the health token', async () => {
    const check = vi.fn(async () => ({ ok: true }));
    const b = createBilling({ ...base(), healthToken: 'tok', healthChecks: { check } });
    expect((await b.handleHealth(new Request('https://x/'))).status).toBe(401);
    expect(check).not.toHaveBeenCalled();
  });

  it('storeTimeoutMs: a store that hangs answers health 503 store_error and fails a webhook with store_error; onError gets a TimeoutError', async () => {
    const errors: Array<[unknown, unknown]> = [];
    const hanging = new Proxy(memoryStore(), { get: () => () => new Promise(() => {}) });
    const now = new Date();
    const b = createBilling({ ...base(), store: hanging, storeTimeoutMs: 20, healthToken: 'tok', log: () => {}, now: () => now, onError: (e, c) => void errors.push([e, c]) });
    const health = await b.handleHealth(new Request('https://x/', auth));
    expect([health.status, await health.json()]).toEqual([503, { error: 'store_error' }]);
    const body = JSON.stringify(subscriptionEvent({ eventId: 'evt_hang' }));
    const res = await b.handleWebhook(signed(body, 's', now));
    expect([res.status, await res.json()]).toEqual([500, { error: 'store_error' }]);
    await expect(b.hasAccess('user_1', 'pro')).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(errors.map(([e, c]) => [(e as Error).name, (c as { reason: string }).reason])).toEqual([['TimeoutError', 'store_error'], ['TimeoutError', 'store_error']]);
  });
});

describe('webhook options through createBilling', () => {
  it('webhookSecret as an array (rotation) and clockSkewSeconds reach the handler', async () => {
    const now = new Date();
    const b = createBilling({ ...base(), webhookSecret: ['old', 'new'], clockSkewSeconds: 5, now: () => now, log: () => {} });
    const one = JSON.stringify(subscriptionEvent({ eventId: 'evt_old' }));
    const two = JSON.stringify(subscriptionEvent({ eventId: 'evt_new' }));
    expect((await b.handleWebhook(signed(one, 'old', now))).status).toBe(200);
    expect((await b.handleWebhook(signed(two, 'new', now))).status).toBe(200);
    const ahead = await b.handleWebhook(signed(two, 'new', new Date(now.getTime() + 10_000)));
    expect(await ahead.json()).toEqual({ error: 'future_timestamp' });
  });

  it('hookTimeoutMs and onError reach the handler', async () => {
    const now = new Date();
    const errors: string[] = [];
    const b = createBilling({ ...base(), now: () => now, log: () => {}, hookTimeoutMs: 20, onTransaction: () => new Promise(() => {}), onError: (e, c) => void errors.push(`${(e as Error).name}:${c.reason}`) });
    const res = await b.handleWebhook(signed(JSON.stringify(loadFixture('transaction.completed')), 's', now));
    expect(res.status).toBe(500);
    expect(errors).toEqual(['TimeoutError:hook_error']);
  });
});
