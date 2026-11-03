import { describe, expect, it } from 'vitest';
import { billingFromEnv, readinessChecks } from '../src/config';
import type { FetchLike } from '../src/core/paddle-api';
import type { Store } from '../src/core/types';
import { memoryStore } from '../src/memory';

// Readiness (since v0.8.1+): the deploy-time checks a health route shows, so a missing permission, migration or cron
// secret is red before the first payment needs it, not after.
const RECOVERY = ['notification.read', 'subscription.read', 'transaction.read', 'adjustment.read'];

function paddle(answer: { status?: number; environment?: string; permissions?: string[] } = {}) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url} ${init?.headers?.Authorization ? 'auth' : 'noauth'}`);
    const status = answer.status ?? 200;
    const body = status === 200
      ? { data: { api: { environment: answer.environment ?? 'sandbox' }, caller: { auth_type: 'api_key', permissions: answer.permissions ?? RECOVERY } } }
      : { error: { code: 'forbidden' } };
    return { ok: status < 300, status, json: async () => body };
  };
  return { fetch, calls };
}

const run = async (checks: Record<string, () => Promise<{ ok: boolean; detail?: string }>>) =>
  Object.fromEntries(await Promise.all(Object.entries(checks).map(async ([k, c]) => [k, await c()] as const)));

describe('readinessChecks', () => {
  it('all good: one call to Paddle\'s API root, cached', async () => {
    const p = paddle();
    const checks = readinessChecks({ apiKey: 'pdl_sdbx_k', environment: 'sandbox', store: memoryStore(), cronSecret: 'x'.repeat(32), fetch: p.fetch });
    expect(await run(checks)).toEqual({
      paddle_api_key: { ok: true, detail: '4 permissions present' },
      migrations: { ok: true },
      cron_secret: { ok: true },
    });
    await run(checks);
    expect(p.calls).toEqual(['GET https://sandbox-api.paddle.com/ auth']);
  });

  it('names the missing permissions, never the key', async () => {
    const p = paddle({ permissions: ['subscription.read', 'transaction.read'] });
    const r = await run(readinessChecks({ apiKey: 'pdl_sdbx_secretvalue', environment: 'sandbox', permissions: ['subscription.write'], fetch: p.fetch }));
    expect(r.paddle_api_key).toEqual({ ok: false, detail: 'missing permissions: notification.read, adjustment.read, subscription.write' });
    expect(JSON.stringify(r)).not.toContain('secretvalue');
  });

  it('prices by label also need price.read and product.read', async () => {
    const r = await run(readinessChecks({ apiKey: 'pdl_sdbx_k', environment: 'sandbox', resolvesPrices: true, fetch: paddle().fetch }));
    expect(r.paddle_api_key).toEqual({ ok: false, detail: 'missing permissions: price.read, product.read' });
  });

  it('a refused key, a key of the other environment, no key, and Paddle down', async () => {
    expect((await run(readinessChecks({ apiKey: 'pdl_sdbx_k', environment: 'sandbox', fetch: paddle({ status: 403 }).fetch }))).paddle_api_key)
      .toEqual({ ok: false, detail: 'Paddle refused the API key (403): wrong, revoked, or a key of the other environment' });
    expect((await run(readinessChecks({ apiKey: 'pdl_live_k', environment: 'production', fetch: paddle({ environment: 'sandbox' }).fetch }))).paddle_api_key)
      .toEqual({ ok: false, detail: 'the API key is for sandbox, the app runs production' });
    expect((await run(readinessChecks({ apiKey: undefined, environment: 'sandbox', fetch: paddle().fetch }))).paddle_api_key)
      .toEqual({ ok: false, detail: 'PADDLE_API_KEY is missing' });
    const down: FetchLike = async () => { throw new TypeError('fetch failed'); };
    expect((await run(readinessChecks({ apiKey: 'pdl_sdbx_k', environment: 'sandbox', fetch: down }))).paddle_api_key)
      .toEqual({ ok: false, detail: 'Paddle did not answer' });
  });

  it('a failure is not cached for long: the next check asks again', async () => {
    let status = 503;
    const fetch: FetchLike = async (url, init) => (status === 200 ? paddle().fetch(url, init) : { ok: false, status, json: async () => ({}) });
    let now = 0;
    const checks = readinessChecks({ apiKey: 'pdl_sdbx_k', environment: 'sandbox', fetch, now: () => now });
    expect((await checks.paddle_api_key!()).ok).toBe(false);
    status = 200;
    now = 61_000;
    expect((await checks.paddle_api_key!()).ok).toBe(true);
  });

  it('migrations: a store without 003 or 004, or one that throws, is named', async () => {
    const base = memoryStore();
    const no003: Store = { ...base, recovery: undefined };
    const no004: Store = { ...base, getOwnedIds: undefined };
    const broken: Store = { ...base, getOwnedIds: async () => { throw new Error('relation "paddle_owned_ids" does not exist'); } };
    const m = async (store: Store) => (await run(readinessChecks({ apiKey: undefined, environment: 'sandbox', store }))).migrations;
    expect(await m(no003)).toEqual({ ok: false, detail: 'migration 003_recovery is missing' });
    expect(await m(no004)).toEqual({ ok: false, detail: 'migration 004_claim_tokens_owned_ids is missing' });
    expect(await m(broken)).toEqual({ ok: false, detail: 'migration 004_claim_tokens_owned_ids is missing' });
  });

  it('cron secret: checked only when passed; missing or short is a failure', async () => {
    expect('cron_secret' in readinessChecks({ apiKey: undefined, environment: 'sandbox' })).toBe(false);
    const c = async (cronSecret: string | undefined) => (await run(readinessChecks({ apiKey: undefined, environment: 'sandbox', cronSecret }))).cron_secret;
    expect(await c(undefined)).toEqual({ ok: false, detail: 'CRON_SECRET is missing' });
    expect(await c('short')).toEqual({ ok: false, detail: 'CRON_SECRET is shorter than 16 characters' });
  });
});

describe('billingFromEnv({ readiness })', () => {
  const env = { PADDLE_ENV: 'sandbox', PADDLE_NOTIFICATION_WEBHOOK_SECRET: 'pdl_ntfset_r', NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: 'test_r', PADDLE_PRICES: '{"pro":"pri_pro"}', PADDLE_HEALTH_TOKEN: 'h'.repeat(20), PADDLE_API_KEY: 'pdl_sdbx_k' };

  it('adds the checks to health, next to the app\'s own', async () => {
    const p = paddle({ permissions: [...RECOVERY, 'subscription.write'] });
    const { billing } = billingFromEnv(env, {
      requiredPrices: ['pro'], store: memoryStore(), log: () => {},
      readiness: { cronSecret: 'c'.repeat(32), permissions: ['subscription.write'], fetch: p.fetch },
      healthChecks: { own: () => ({ ok: true }) },
    });
    const res = await billing!.handleHealth(new Request('https://app.test/', { headers: { authorization: `Bearer ${'h'.repeat(20)}` } }));
    const h = (await res.json()) as { checks: Record<string, { ok: boolean }> };
    expect(Object.keys(h.checks).sort()).toEqual(['cron_secret', 'migrations', 'own', 'paddle_api_key']);
    expect(Object.values(h.checks).every((c) => c.ok)).toBe(true);
  });

  it('without the option, health has no readiness checks and nothing calls Paddle', async () => {
    const { billing } = billingFromEnv(env, { requiredPrices: ['pro'], store: memoryStore(), log: () => {} });
    expect(billing!.config.healthChecks).toBeUndefined();
  });
});
