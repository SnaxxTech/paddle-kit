import { describe, expect, it } from 'vitest';
import { createBilling } from '../src/core/billing';
import { memoryStore } from '../src/memory';
import { createNextRoute, createWebhookRoute } from '../src/next';
import { sign } from './helpers/sign';
import { subscriptionEvent } from './helpers/fixtures';

const body = JSON.stringify(subscriptionEvent({ eventId: 'evt_adapter' }));
const makeBilling = () =>
  createBilling({ environment: 'sandbox', webhookSecret: 'sec', store: memoryStore(), entitlements: {}, healthToken: 't', log: () => {} });
const headers = () => ({ 'content-type': 'application/json', 'paddle-signature': sign(body, 'sec') });

describe('next adapter', () => {
  it('POST verifies and stores; GET serves health', async () => {
    const route = createNextRoute(makeBilling());
    expect((await route.POST(new Request('https://x/', { method: 'POST', headers: headers(), body }))).status).toBe(200);
    expect((await route.GET(new Request('https://x/', { headers: { authorization: 'Bearer t' } }))).status).toBe(200);
  });
});

describe('createWebhookRoute', () => {
  const post = () => new Request('https://x/', { method: 'POST', headers: headers(), body });
  const get = (token?: string) => new Request('https://x/', token ? { headers: { authorization: `Bearer ${token}` } } : {});

  it('billing on: POST verifies and stores, GET serves health with the billing health token', async () => {
    const route = createWebhookRoute({ billing: makeBilling(), problems: [] });
    expect((await route.POST(post())).status).toBe(200);
    const health = await route.GET(get('t'));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ environment: 'sandbox', lastFailureReason: null });
    expect((await route.GET(get('wrong'))).status).toBe(401);
  });

  it('billing on without a health token: GET is 404 health_off', async () => {
    const billing = createBilling({ environment: 'sandbox', webhookSecret: 'sec', store: memoryStore(), entitlements: {}, log: () => {} });
    const res = await createWebhookRoute({ billing, problems: [], healthToken: 't' }).GET(get('t'));
    expect([res.status, await res.json()]).toEqual([404, { error: 'health_off' }]);
  });

  it('billing off and no problems: 404, GET says billing_off', async () => {
    const route = createWebhookRoute({ billing: null, problems: [] });
    expect((await route.POST(post())).status).toBe(404);
    const res = await route.GET(get());
    expect([res.status, await res.json()]).toEqual([404, { error: 'billing_off' }]);
  });

  it('misconfigured: 503; only a GET with the health token sees the problem names', async () => {
    const problems = ['PADDLE_PRICES is missing'];
    const route = createWebhookRoute({ billing: null, problems, healthToken: 't' });
    expect((await route.POST(post())).status).toBe(503);
    for (const req of [get(), get('wrong')]) {
      const res = await route.GET(req);
      expect([res.status, await res.text()]).toEqual([503, '']);
    }
    const res = await route.GET(get('t'));
    expect([res.status, await res.json()]).toEqual([503, { error: 'misconfigured', problems }]);
    // No health token configured: nobody sees the names, not even a request with an empty bearer.
    const closed = createWebhookRoute({ billing: null, problems });
    expect(await (await closed.GET(new Request('https://x/', { headers: { authorization: 'Bearer ' } }))).text()).toBe('');
  });

  it('the README pattern: billing is built only from a config, so a missing secret never throws at import', async () => {
    const { readBillingEnv } = await import('../src/config');
    const { config, problems } = readBillingEnv({ PADDLE_ENV: 'sandbox', NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: 'test_x' }, { requiredPrices: [] });
    const billing = config ? createBilling({ environment: config.environment, webhookSecret: config.webhookSecret, store: memoryStore(), entitlements: {} }) : null;
    expect(billing).toBeNull();
    expect((await createWebhookRoute({ billing, problems }).POST(post())).status).toBe(503);
  });
});
