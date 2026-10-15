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
