import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPaddleTransport, PaddleTransportError } from '../src/core/transport';
import type { FetchLike } from '../src/core/paddle-api';

const url = 'https://sandbox-api.paddle.com/subscriptions';
const init = { method: 'GET', headers: { Authorization: 'Bearer pdl_sdbx_fake_audit_key' } };
const response = (status = 200, retryAfter?: string) => ({ ok: status < 400, status,
  headers: { get: (name: string) => name === 'retry-after' ? retryAfter ?? null : null }, json: async () => ({ data: [] }) });
afterEach(() => vi.useRealTimers());

describe('Paddle API transport', () => {
  it('retries transient GETs and closes after success', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<FetchLike>().mockResolvedValueOnce(response(503)).mockResolvedValue(response());
    const t = createPaddleTransport({ fetch });
    const pending = t.fetch(url, init);
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(t.state().state).toBe('closed');
    expect(fetch.mock.calls[0]![1].redirect).toBe('error');
  });

  it('never retries mutations or authentication errors', async () => {
    for (const [method, status] of [['POST', 503], ['GET', 401], ['GET', 403]] as const) {
      const fetch = vi.fn<FetchLike>().mockResolvedValue(response(status));
      expect((await createPaddleTransport({ fetch }).fetch(url, { ...init, method })).status).toBe(status);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('honors Retry-After instead of hammering during the provider cooldown', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<FetchLike>().mockResolvedValueOnce(response(429, '1')).mockResolvedValue(response());
    const t = createPaddleTransport({ fetch });
    const pending = t.fetch(url, init);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(t.fetch(url, init)).rejects.toMatchObject({ code: 'circuit_open' });
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(t.state().state).toBe('closed');
  });

  it('returns 429 without exceeding its budget for a long Retry-After', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(response(429, '60'));
    const t = createPaddleTransport({ fetch, budgetMs: 1000 });
    expect((await t.fetch(url, init)).status).toBe(429);
    await expect(t.fetch(url, init)).rejects.toMatchObject({ code: 'circuit_open' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('opens after failures, permits exactly one recovery probe, then heals', async () => {
    vi.useFakeTimers();
    let release!: (v: ReturnType<typeof response>) => void;
    const fetch = vi.fn<FetchLike>().mockResolvedValueOnce(response(503))
      .mockImplementationOnce(() => new Promise(r => { release = r; })).mockResolvedValue(response());
    const t = createPaddleTransport({ fetch, maxRetries: 0, failureThreshold: 1, cooldownMs: 1000 });
    await t.fetch(url, init);
    await expect(t.fetch(url, init)).rejects.toMatchObject({ code: 'circuit_open' });
    await vi.advanceTimersByTimeAsync(1000);
    const probe = t.fetch(url, init);
    await expect(t.fetch(url, init)).rejects.toMatchObject({ code: 'circuit_open' });
    expect(t.state().state).toBe('half_open');
    release(response());
    await probe;
    expect(t.state()).toMatchObject({ state: 'closed', consecutiveFailures: 0, retryAt: null });
    await t.fetch(url, init);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('a failed probe reopens and an old in-flight success cannot close a newer circuit', async () => {
    vi.useFakeTimers();
    let release!: (v: ReturnType<typeof response>) => void;
    const fetch = vi.fn<FetchLike>().mockImplementationOnce(() => new Promise(r => { release = r; })).mockResolvedValue(response(503));
    const t = createPaddleTransport({ fetch, maxRetries: 0, failureThreshold: 1, cooldownMs: 1000 });
    const old = t.fetch(url, init);
    await t.fetch(url, init);
    release(response());
    await old;
    expect(t.state().state).toBe('open');
    await vi.advanceTimersByTimeAsync(1000);
    await t.fetch(url, init);
    expect(t.state().state).toBe('open');
  });

  it('bounds a stalled fetch AND a stalled JSON body, even if the fetch ignores abort', async () => {
    vi.useFakeTimers();
    for (const fetch of [async () => new Promise<never>(() => {}), async () => ({ ...response(), json: () => new Promise<never>(() => {}) })]) {
      const t = createPaddleTransport({ fetch, maxRetries: 0, requestTimeoutMs: 50 });
      const pending = t.fetch(url, init).catch(e => e);
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toMatchObject({ code: 'timeout' });
    }
  });

  it('caller cancellation does not trip the circuit and errors do not expose secrets', async () => {
    const controller = new AbortController();
    const t = createPaddleTransport({ fetch: async () => { throw new Error(init.headers.Authorization); }, maxRetries: 0 });
    await expect(t.fetch(url, init)).rejects.toThrow('Paddle API network');
    controller.abort();
    const prior = t.state();
    await expect(t.fetch(url, { ...init, signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(t.state()).toEqual(prior);
    expect(new PaddleTransportError('circuit_open').message).not.toContain('pdl_sdbx');
  });

  it('does not forward credentials outside Paddle', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(response());
    await expect(createPaddleTransport({ fetch }).fetch('https://evil.example/', init)).rejects.toThrow('only accepts Paddle');
    expect(fetch).not.toHaveBeenCalled();
  });
});
