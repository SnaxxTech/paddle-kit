import { afterEach, describe, expect, it, vi } from 'vitest';
import * as config from '../src/config';
import * as core from '../src/core';
import { memoryStore } from '../src/memory';
import * as next from '../src/next';
import * as reconcile from '../src/reconcile';
import { runReadmeBlock } from './helpers/readme-blocks';

// The README's "Standard setup" blocks, run as written (README.md is the source; nothing is copied here).
const env = {
  PADDLE_ENV: 'sandbox', PADDLE_NOTIFICATION_WEBHOOK_SECRET: 'pdl_ntfset_std', NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: 'test_std',
};
class Pool { query = async () => ({ rows: [] }); }
const postgres = { postgresStore: () => memoryStore() };

function libBilling(extra: Record<string, string>) {
  vi.stubGlobal('process', { ...process, env: { ...env, ...extra } });
  return runReadmeBlock('\n`lib/billing.ts`\n', { '@neondatabase/serverless': { Pool }, 'paddle-kit/config': config, 'paddle-kit/postgres': postgres });
}

afterEach(() => vi.unstubAllGlobals());

describe('README standard setup: lib/billing.ts', () => {
  it.each([
    ['a cycle map', { pro: { monthly: 'pri_m', yearly: 'pri_y' } }, ['pri_m', 'pri_y']],
    ['a flat price id', { pro: 'pri_pro' }, ['pri_pro']],
  ])('entitlements from %s are keyed by whole price ids', (_, prices, ids) => {
    const { billing, problems } = libBilling({ PADDLE_PRICES: JSON.stringify(prices) });
    expect(problems).toEqual([]);
    expect(Object.keys(billing.config.entitlements).sort()).toEqual(ids);
    for (const id of ids) expect(billing.config.entitlements[id]).toEqual(['pro']);
  });
});

describe('README standard setup: the recovery route', () => {
  const route = (lib: Record<string, unknown>) =>
    runReadmeBlock('\n`app/api/cron/billing-recovery/route.ts`\n', { 'paddle-kit/reconcile': reconcile, 'paddle-kit/next': next, '@/lib/billing': lib });
  const get = (lib: Record<string, unknown>, auth?: string, secret?: string) => {
    vi.stubGlobal('process', { ...process, env: secret === undefined ? {} : { CRON_SECRET: secret } });
    return route(lib).GET(new Request('https://app.test/api/cron/billing-recovery', auth ? { headers: { authorization: auth } } : {}));
  };
  const on = () => {
    const billing = core.createBilling({ environment: 'sandbox', webhookSecret: 's', store: memoryStore(), entitlements: {}, owns: () => true });
    return { billing, config: { apiKey: 'pdl_sdbx_k' }, problems: [] };
  };

  it('refuses every call while CRON_SECRET is unset, "Bearer undefined" included', async () => {
    for (const auth of [undefined, 'Bearer undefined', 'Bearer ', 'Bearer']) expect((await get(on(), auth)).status).toBe(401);
    expect((await get(on(), 'Bearer wrong', 's3cret')).status).toBe(401);
  });

  it('with the secret, runs recovery and answers its result', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return Response.json({ data: [], meta: { pagination: { has_more: false } } });
    });
    const res = await get(on(), 'Bearer s3cret', 's3cret');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'done' });
    expect(calls.length).toBeGreaterThan(0);
    vi.stubGlobal('fetch', async () => Response.json({ error: { code: 'internal_error' } }, { status: 500 }));
    const failed = await get(on(), 'Bearer s3cret', 's3cret');
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ status: 'failed' });
  });

  it('a misconfigured app is a failed run (500 with the problem names), not "off"', async () => {
    const res = await get({ billing: null, config: null, problems: ['PADDLE_PRICES is missing'] }, 'Bearer s3cret', 's3cret');
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ status: 'misconfigured', problems: ['PADDLE_PRICES is missing'] });
  });

  it('billing on but no API key is a failed run too', async () => {
    const lib = { ...on(), config: { apiKey: undefined } };
    expect((await get(lib, 'Bearer s3cret', 's3cret')).status).toBe(500);
  });

  it('billing deliberately off (no billing variable at all) answers 200 off', async () => {
    const res = await get({ billing: null, config: null, problems: [] }, 'Bearer s3cret', 's3cret');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'off' });
  });
});
