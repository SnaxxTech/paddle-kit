import { describe, expect, it } from 'vitest';
import { createBilling } from '../src/core/billing';
import { memoryStore } from '../src/memory';
import { createNextRoute } from '../src/next';
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
