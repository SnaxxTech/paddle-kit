// Read one price from Paddle (by id, or by the label the catalog CLI gave it), and format a lowest-unit amount.
// Web fetch only (edge-safe). No caching: the app decides how long a price may be stale (README, "Show the price from Paddle").
import { LIVE_BASE, PaddleError, SANDBOX_BASE, paddleClient, type FetchLike, type Json } from '../core/paddle-api';
import type { PriceMap } from '../config';

export type { FetchLike, PriceMap };

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

export type PriceErrorCode = 'unauthorized' | 'not_found' | 'ambiguous' | 'timeout' | 'network' | 'malformed' | 'http';

/**
 * `unauthorized`: 401/403, or a key that does not match `environment`. `not_found`: 404, or no active price with the
 * label. `ambiguous`: more than one active price with the label (since v0.7.0). `timeout` / `network`: no answer.
 * `malformed`: a 2xx answer that is not a price. `http`: any other status (429, 5xx), in `status`.
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

/**
 * Runs `work` against the Paddle API of `opts.environment` within `opts.timeoutMs` (default 5000; the request is aborted),
 * turning every failure into a `PriceError`.
 */
async function withApi<T>(what: string, opts: GetPriceOptions, work: (api: ReturnType<typeof paddleClient>) => Promise<T>): Promise<T> {
  const keyEnv = opts.apiKey?.startsWith('pdl_sdbx_') ? 'sandbox' : opts.apiKey?.startsWith('pdl_live_') ? 'production' : null;
  if (keyEnv !== opts.environment) throw new PriceError('unauthorized', `API key does not match environment "${opts.environment}"`);
  const timeoutMs = opts.timeoutMs ?? 5000;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new PriceError('timeout', `${what}: no answer in ${timeoutMs} ms`)); // before abort, so this wins the race
      controller.abort();
    }, timeoutMs);
  });
  const fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  const api = paddleClient(opts.environment === 'production' ? LIVE_BASE : SANDBOX_BASE, opts.apiKey, fetchImpl, [opts.apiKey], controller.signal);
  try {
    return await Promise.race([work(api), timeout]);
  } catch (error) {
    if (error instanceof PriceError) throw error;
    if (error instanceof PaddleError && error.status !== undefined) {
      const code = error.status === 401 || error.status === 403 ? 'unauthorized' : error.status === 404 ? 'not_found' : 'http';
      throw new PriceError(code, error.message, error.status); // already redacted by paddleClient
    }
    if (error instanceof PaddleError) throw new PriceError('malformed', error.message); // e.g. a pagination link to another host
    // fetch itself failed (DNS, TLS, connection reset). Its text is not ours: keep it out of the message.
    throw new PriceError('network', `${what}: network error`);
  } finally {
    clearTimeout(timer);
  }
}

/** `GET /prices/{id}` with the kit's pinned `Paddle-Version`. Throws `PriceError`. */
export async function getPrice(priceId: string, opts: GetPriceOptions): Promise<Price> {
  const what = `GET /prices/${priceId}`;
  return withApi(what, opts, async (api) => {
    if (typeof priceId !== 'string' || !/^pri_[A-Za-z0-9]+$/.test(priceId)) throw new PriceError('not_found', 'priceId is not a Paddle price id (pri_…)');
    const price = priceFrom((await api.call('GET', `/prices/${priceId}`)).data);
    if (!price) throw new PriceError('malformed', `${what}: the answer is not a price`);
    return price;
  });
}

export type Cycle = 'monthly' | 'yearly' | 'once';
const LABEL = /^([A-Za-z][A-Za-z0-9_]*)-(monthly|yearly|once)$/;

/** Active prices whose product the catalog CLI labelled `app` (product `custom_data.paddle_kit`), by price label. */
async function labelled(app: string, api: ReturnType<typeof paddleClient>): Promise<Map<string, Json[]>> {
  const byLabel = new Map<string, Json[]>();
  for (const p of await api.list('/prices?status=active&include=product&per_page=200')) {
    const label = p.custom_data?.paddle_kit_price;
    if (p.status !== 'active' || typeof label !== 'string' || !LABEL.test(label)) continue;
    if (p.product?.custom_data?.paddle_kit !== app || p.product?.status === 'archived') continue;
    byLabel.set(label, [...(byLabel.get(label) ?? []), p]);
  }
  return byLabel;
}

/**
 * The active price the catalog CLI labelled `<key>-<cycle>` on `app`'s product, as `getPrice` returns it: no price id
 * needed in the app. Throws `PriceError` `not_found` (none) or `ambiguous` (more than one), and the codes of `getPrice`.
 */
export async function findPrice(label: { app: string; key: string; cycle: Cycle }, opts: GetPriceOptions): Promise<Price> {
  const tag = `${label.key}-${label.cycle}`;
  const what = `price "${tag}" of app "${label.app}"`;
  return withApi(what, opts, async (api) => {
    const found = (await labelled(label.app, api)).get(tag) ?? [];
    if (found.length === 0) throw new PriceError('not_found', `${what}: no active price has this label (run paddle-kit-catalog)`);
    if (found.length > 1) throw new PriceError('ambiguous', `${what}: ${found.length} active prices have this label (${found.map((p) => p.id).join(', ')}): archive all but one`);
    const price = priceFrom(found[0]);
    if (!price) throw new PriceError('malformed', `${what}: the answer is not a price`);
    return price;
  });
}

/**
 * Every active price labelled on `app`'s product, as the `PADDLE_PRICES` map the catalog CLI writes: a key with only a
 * one-time price is flat (`{ scan: "pri_…" }`), any other key is a map of cycle to id. `ambiguous` when two active
 * prices share a label. `readBillingEnv({ resolvePrices })` uses it when PADDLE_PRICES is unset.
 */
export async function findPriceMap(app: string, opts: GetPriceOptions): Promise<PriceMap> {
  return withApi(`prices of app "${app}"`, opts, async (api) => {
    const map: PriceMap = {};
    const byLabel = [...(await labelled(app, api))].sort(([a], [b]) => a.localeCompare(b));
    for (const [label, found] of byLabel) {
      if (found.length > 1) throw new PriceError('ambiguous', `price "${label}" of app "${app}": ${found.length} active prices have this label: archive all but one`);
      const [, key, cycle] = LABEL.exec(label)!;
      const onlyOnce = byLabel.every(([l]) => !l.startsWith(`${key}-`) || l === `${key}-once`);
      if (onlyOnce) map[key!] = found[0]!.id;
      else ((map[key!] ??= {}) as Record<string, string>)[cycle!] = found[0]!.id;
    }
    return map;
  });
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
