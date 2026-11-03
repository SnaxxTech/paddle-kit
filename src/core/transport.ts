import type { FetchLike } from './paddle-api';

export type TransportErrorCode = 'timeout' | 'aborted' | 'network' | 'circuit_open' | 'invalid_response';

/** Messages contain no URL, credentials, provider body, or underlying network error. */
export class PaddleTransportError extends Error {
  override name = 'PaddleTransportError';
  constructor(readonly code: TransportErrorCode, readonly retryAt: number | null = null) {
    super(`Paddle API ${code}`);
  }
}

export interface CircuitState {
  state: 'closed' | 'open' | 'half_open';
  consecutiveFailures: number;
  retryAt: string | null;
}

export interface TransportOptions {
  fetch?: FetchLike;
  /** A complete attempt, including the JSON body. Default 4000. */
  requestTimeoutMs?: number;
  /** Includes retries and backoff. Default 10000. */
  budgetMs?: number;
  /** GET only. Mutations are never retried automatically. Default 2. */
  maxRetries?: number;
  failureThreshold?: number;
  cooldownMs?: number;
}

export interface PaddleTransport {
  fetch: FetchLike;
  state(): CircuitState;
}

const transient = (status: number) => [408, 429, 500, 502, 503, 504].includes(status);

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`paddle-kit: ${name} must be a positive integer`);
  return value;
}

function retryDelay(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new PaddleTransportError('aborted');
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new PaddleTransportError('aborted')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * One transport per app/account/environment, reused by pricing and reconciliation. The breaker is local to this
 * instance: it protects a warm process, not an entire serverless fleet. After cooling down exactly one call probes
 * Paddle; a successful probe closes it. It never affects incoming webhooks or local entitlement reads.
 */
export function createPaddleTransport(opts: TransportOptions = {}): PaddleTransport {
  const timeoutMs = positive(opts.requestTimeoutMs ?? 4000, 'requestTimeoutMs');
  const budgetMs = positive(opts.budgetMs ?? 10000, 'budgetMs');
  const threshold = positive(opts.failureThreshold ?? 3, 'failureThreshold');
  const cooldownMs = positive(opts.cooldownMs ?? 30000, 'cooldownMs');
  const maxRetries = opts.maxRetries ?? 2;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) throw new Error('paddle-kit: maxRetries must be between 0 and 10');
  const rawFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  let failures = 0;
  let until: number | null = null;
  let probing = false;
  // An old in-flight success must not close a circuit opened by a newer failure.
  let generation = 0;

  function open(delay: number): void {
    until = Math.max(until ?? 0, Date.now() + delay);
    generation++;
  }

  async function attempt(url: string, init: Parameters<FetchLike>[1], remaining: number) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    init.signal?.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new PaddleTransportError(timedOut ? 'timeout' : 'aborted')), { once: true });
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(timeoutMs, remaining));
      if (init.signal?.aborted) controller.abort();
    });
    try {
      // Buffer JSON inside the deadline: a response whose headers arrive promptly can still stall on its body.
      const work = (async () => {
        // `manual`, not `error`: Cloudflare Workers rejects the "error" redirect mode (since v0.8.7). A redirect is never
        // followed (the key would go along); it fails like a network error, as `error` did on other hosts.
        const response = await rawFetch(url, { ...init, signal: controller.signal, redirect: 'manual' });
        if (response.status === 0 || (response.status >= 300 && response.status < 400)) throw new PaddleTransportError('network');
        let payload: unknown;
        let malformed = false;
        try { payload = await response.json(); } catch { malformed = true; }
        if (response.ok && malformed) throw new PaddleTransportError('invalid_response');
        return { ok: response.ok, status: response.status, headers: response.headers, json: async () => payload };
      })();
      return await Promise.race([work, cancelled]);
    } catch (error) {
      if (error instanceof PaddleTransportError) throw error;
      throw new PaddleTransportError('network');
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', abort);
    }
  }

  const fetchImpl: FetchLike = async (url, init) => {
    const target = new URL(url);
    if (!['https://api.paddle.com', 'https://sandbox-api.paddle.com'].includes(target.origin) || target.username || target.password) {
      throw new Error('paddle-kit: transport only accepts Paddle API URLs');
    }
    if (init.signal?.aborted) throw new PaddleTransportError('aborted');
    let probe = false;
    if (until !== null) {
      if (Date.now() < until || probing) throw new PaddleTransportError('circuit_open', until);
      probing = true;
      probe = true;
      generation++;
    }
    let ticket = generation;
    const deadline = Date.now() + budgetMs;
    const retries = init.method.toUpperCase() === 'GET' ? maxRetries : 0;
    try {
      for (let n = 0; ; n++) {
        let response: Awaited<ReturnType<FetchLike>> | undefined;
        let failure: PaddleTransportError | undefined;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new PaddleTransportError('timeout');
        try { response = await attempt(url, init, remaining); } catch (error) { failure = error as PaddleTransportError; }
        if (failure?.code === 'aborted') throw failure;
        const retryable = failure !== undefined || (response !== undefined && transient(response.status));
        const providerDelay = retryDelay(response?.headers?.get('retry-after'));
        if (response?.status === 429) {
          open(providerDelay ?? cooldownMs);
          ticket = generation;
          probing = true;
          probe = true;
        }
        if (!retryable) {
          if (ticket === generation) { failures = 0; until = null; }
          return response!;
        }
        const backoff = Math.floor(200 * 2 ** n * (0.5 + Math.random() * 0.5));
        const delay = providerDelay ?? backoff;
        if (n < retries && delay < deadline - Date.now()) {
          await pause(delay, init.signal);
          continue;
        }
        if (ticket === generation) {
          failures++;
          if (probe || failures >= threshold) open(Math.max(cooldownMs, providerDelay ?? 0));
        }
        if (failure) throw failure;
        return response!; // paddleClient classifies HTTP errors, retaining the provider status.
      }
    } finally {
      if (probe) probing = false;
    }
  };
  return {
    fetch: fetchImpl,
    state: () => ({ state: until === null ? 'closed' : probing ? 'half_open' : 'open', consecutiveFailures: failures, retryAt: until === null ? null : new Date(until).toISOString() }),
  };
}
