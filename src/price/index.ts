// Read one price from Paddle, and format a lowest-unit amount. Web fetch only (edge-safe). No caching: the app
// decides how long a price may be stale (README, "Show the price from Paddle").
import { LIVE_BASE, PaddleError, SANDBOX_BASE, paddleClient, type FetchLike, type Json } from '../core/paddle-api';

export type { FetchLike };

export interface Price {
  id: string;
  /** Lowest currency unit as a string, e.g. "1500" = 15.00 USD, "1500" = ¥1500. */
  amount: string;
  currency: string;
  /** null for a one-time price. */
  interval: null | { interval: 'day' | 'week' | 'month' | 'year'; frequency: number };
  name: string | null;
  status: 'active' | 'archived';
}

export type PriceErrorCode = 'unauthorized' | 'not_found' | 'timeout' | 'network' | 'malformed' | 'http';

/**
 * `unauthorized`: 401/403, or a key that does not match `environment`. `not_found`: 404. `timeout` / `network`: no
 * answer. `malformed`: a 2xx answer that is not a price. `http`: any other status (429, 5xx), in `status`.
 * The message never contains the API key.
 */
export class PriceError extends PaddleError {
  override name = 'PriceError';
  constructor(readonly code: PriceErrorCode, message: string, status?: number) {
    super(message, status);
  }
}

export interface GetPriceOptions {
  apiKey: string;
  environment: 'sandbox' | 'production';
  fetch?: FetchLike;
  /** Default 5000. */
  timeoutMs?: number;
}

const INTERVALS = ['day', 'week', 'month', 'year'];

function priceFrom(data: Json | undefined): Price | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const { id, unit_price: unit, billing_cycle: cycle, name, status } = data;
  if (typeof id !== 'string' || !id) return null;
  if (typeof unit?.amount !== 'string' || !/^\d+$/.test(unit.amount) || typeof unit.currency_code !== 'string' || !/^[A-Z]{3}$/.test(unit.currency_code)) return null;
  if (status !== 'active' && status !== 'archived') return null;
  if (name !== null && name !== undefined && typeof name !== 'string') return null;
  let interval: Price['interval'] = null;
  if (cycle !== null && cycle !== undefined) {
    if (!INTERVALS.includes(cycle.interval) || !Number.isSafeInteger(cycle.frequency) || cycle.frequency < 1) return null;
    interval = { interval: cycle.interval, frequency: cycle.frequency };
  }
  return { id, amount: unit.amount, currency: unit.currency_code, interval, name: name ?? null, status };
}

/** `GET /prices/{id}` with the kit's pinned `Paddle-Version`. Throws `PriceError`. */
export async function getPrice(priceId: string, opts: GetPriceOptions): Promise<Price> {
  const keyEnv = opts.apiKey?.startsWith('pdl_sdbx_') ? 'sandbox' : opts.apiKey?.startsWith('pdl_live_') ? 'production' : null;
  if (keyEnv !== opts.environment) throw new PriceError('unauthorized', `API key does not match environment "${opts.environment}"`);
  if (typeof priceId !== 'string' || !/^pri_[A-Za-z0-9]+$/.test(priceId)) throw new PriceError('not_found', 'priceId is not a Paddle price id (pri_…)');

  const timeoutMs = opts.timeoutMs ?? 5000;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new PriceError('timeout', `GET /prices/${priceId}: no answer in ${timeoutMs} ms`)); // before abort, so this wins the race
      controller.abort();
    }, timeoutMs);
  });
  const fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  const api = paddleClient(opts.environment === 'production' ? LIVE_BASE : SANDBOX_BASE, opts.apiKey, fetchImpl, [opts.apiKey], controller.signal);

  let body: Json;
  try {
    body = await Promise.race([api.call('GET', `/prices/${priceId}`), timeout]);
  } catch (error) {
    if (error instanceof PriceError) throw error;
    if (error instanceof PaddleError && error.status !== undefined) {
      const code = error.status === 401 || error.status === 403 ? 'unauthorized' : error.status === 404 ? 'not_found' : 'http';
      throw new PriceError(code, error.message, error.status); // already redacted by paddleClient
    }
    // fetch itself failed (DNS, TLS, connection reset). Its text is not ours: keep it out of the message.
    throw new PriceError('network', `GET /prices/${priceId}: network error`);
  } finally {
    clearTimeout(timer);
  }
  const price = priceFrom(body.data);
  if (!price) throw new PriceError('malformed', `GET /prices/${priceId}: the answer is not a price`);
  return price;
}

/**
 * Formats a lowest-unit amount with `Intl.NumberFormat`: "1500" USD → "$15", "999" → "$9.99", "1500" JPY → "¥1,500".
 * Zero-decimal currencies are not divided by 100. Whole amounts have no cents.
 */
export function formatPrice(amount: string | number, currency: string, locale = 'en-US'): string {
  const digits = new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const value = Number(amount) / 10 ** digits;
  if (!Number.isFinite(value)) throw new RangeError('formatPrice: amount is not a number');
  const whole = Number.isInteger(value);
  return new Intl.NumberFormat(locale, { style: 'currency', currency, ...(whole ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}) }).format(value);
}
