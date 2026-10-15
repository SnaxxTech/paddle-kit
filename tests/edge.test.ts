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
