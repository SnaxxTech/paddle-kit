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
});

describe('config exposure', () => {
  it('does not expose the webhook secret', () => {
    const billing = createBilling({ ...base(), webhookSecret: 'super-secret-value' });
    expect('webhookSecret' in billing.config).toBe(false);
    expect(JSON.stringify(billing.config)).not.toContain('super-secret-value');
  });
});
