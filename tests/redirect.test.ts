import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readinessChecks } from '../src/config/readiness';
import { PaddleError, paddleClient, SANDBOX_BASE, type FetchLike } from '../src/core/paddle-api';
import { createPaddleTransport, PaddleTransportError } from '../src/core/transport';

// Cloudflare Workers (workerd) rejects the "error" redirect mode with a TypeError, so every Paddle call failed there
// ("Paddle did not answer", recovery `network`). The kit sends `manual` and treats a 3xx as an error itself.
function workerd(status = 200) {
  const seen: unknown[] = [];
  const fetch: FetchLike = async (_url, init) => {
    seen.push(init.redirect);
    if ((init.redirect as string | undefined) === 'error') throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
    const ok = status >= 200 && status < 300;
    return { ok, status, headers: { get: () => null }, json: async () => ({ data: { api: { environment: 'sandbox' }, caller: { permissions: ['subscription.read'] } } }) };
  };
  return { fetch, seen };
}
const init = { method: 'GET', headers: { Authorization: 'Bearer pdl_sdbx_fake_key_123456' } };

describe('Paddle calls work on Cloudflare Workers (no redirect: "error")', () => {
  it('the transport sends manual redirects and gets an answer', async () => {
    const w = workerd();
    expect((await createPaddleTransport({ fetch: w.fetch }).fetch(`${SANDBOX_BASE}/subscriptions`, init)).status).toBe(200);
    expect(w.seen).toEqual(['manual']);
  });

  it('the readiness key check sends manual redirects and gets an answer', async () => {
    const w = workerd();
    const r = await readinessChecks({ apiKey: 'pdl_sdbx_fake_key_123456', environment: 'sandbox', fetch: w.fetch, permissions: [] }).paddle_api_key!();
    expect(r.detail).not.toBe('Paddle did not answer');
    expect(w.seen).toEqual(['manual']);
  });

  it('the shared client (server checkout, portal, catalog, price, reconcile) sends manual redirects', async () => {
    const w = workerd();
    await paddleClient(SANDBOX_BASE, 'pdl_sdbx_fake_key_123456', w.fetch, []).call('GET', '/event-types');
    expect(w.seen).toEqual(['manual']);
  });

  it('a redirect is never followed and is an error on every path', async () => {
    for (const status of [301, 302, 307, 308]) {
      await expect(createPaddleTransport({ fetch: workerd(status).fetch, maxRetries: 0 }).fetch(`${SANDBOX_BASE}/subscriptions`, init)).rejects.toBeInstanceOf(PaddleTransportError);
      const r = await readinessChecks({ apiKey: 'pdl_sdbx_fake_key_123456', environment: 'sandbox', fetch: workerd(status).fetch }).paddle_api_key!();
      expect(r.ok).toBe(false);
      await expect(paddleClient(SANDBOX_BASE, 'pdl_sdbx_fake_key_123456', workerd(status).fetch, []).call('GET', '/event-types')).rejects.toBeInstanceOf(PaddleError);
    }
  });

  it('no source file sends redirect: "error"', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]);
    const offenders = files('src').filter((f) => /redirect\s*:\s*['"]error['"]/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
