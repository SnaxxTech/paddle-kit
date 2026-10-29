// Billing environment validation. Pure and edge-safe (no node: imports, no runtime deps).
// Problem strings name variables (and caller-supplied price keys) only, never values.
import { PriceError, findPriceMap, type FetchLike } from '../price';
import type { OwnsResolver } from '../core/types';

/** key -> price id, or key -> { billing cycle -> price id }. */
export type PriceMap = Record<string, string | Record<string, string>>;

export interface BillingEnv {
  environment: 'sandbox' | 'production';
  /** The first (or only) secret in PADDLE_NOTIFICATION_WEBHOOK_SECRET. */
  webhookSecret: string;
  /**
   * Every secret in PADDLE_NOTIFICATION_WEBHOOK_SECRET (comma-separated during a rotation), for
   * `createBilling({ webhookSecret: config.webhookSecrets })`. Since v0.7.0; always set by `readBillingEnv`.
   */
  webhookSecrets?: string[];
  /**
   * PADDLE_PRICES. Empty (`{}`) when `resolvePrices` is on and PADDLE_PRICES is unset: then read the ids with
   * `await config.resolvePrices()`.
   */
  prices: PriceMap;
  clientToken: string;
  /** Epoch ms, or null when BILLING_LAUNCH_AT is unset and not required. */
  launchAt: number | null;
  enforce: boolean;
  healthToken?: string;
  apiKey?: string;
  /**
   * Every price id in PADDLE_PRICES, for `createBilling({ owns })` on a shared seller account. Absent when the map is
   * empty. Add `productIds` yourself if the app also sells prices that are not in PADDLE_PRICES.
   */
  owns?: { priceIds: string[] };
}

/** What `readBillingEnv` returns with the `resolvePrices` option (since v0.7.0). */
export interface BillingEnvWithLookup extends Omit<BillingEnv, 'owns'> {
  /**
   * PADDLE_PRICES set: every id in it, as without the option. Unset: a resolver over `resolvePrices`, which
   * `createBilling` awaits per event (a failed lookup answers 503, never `not_ours`). Pass it the same way: `owns: config.owns`.
   */
  owns?: { priceIds: string[] } | OwnsResolver;
  /**
   * The price map: PADDLE_PRICES when it is set (no request), else found in Paddle by label (`findPriceMap`) and checked
   * against `requiredPrices` / `requiredCycles`. A found map is kept for `cacheSeconds` in this server instance; a
   * failure is not kept, so the next call asks again. Throws `PriceError`.
   */
  resolvePrices: () => Promise<PriceMap>;
}

export interface ResolvePricesOptions {
  /** The catalog's `app`. */
  app: string;
  /** How long a found map is kept in this server instance. Default 600 (10 min). */
  cacheSeconds?: number;
  fetch?: FetchLike;
  /** Per lookup. Default 5000. */
  timeoutMs?: number;
}

export interface ReadBillingEnvOptions {
  /** Price keys that must be present in PADDLE_PRICES with non-empty ids. */
  requiredPrices: string[];
  /**
   * Billing cycles every nested (cycle map) entry of `requiredPrices` must have, e.g. `['monthly', 'yearly']`.
   * Flat entries (one-time prices) are not affected. Unset: no cycle is required.
   */
  requiredCycles?: string[];
  /** Make BILLING_LAUNCH_AT mandatory. */
  requireLaunchAt?: boolean;
  /**
   * Since v0.7.0: PADDLE_PRICES may be unset. The prices are then found in Paddle by the labels the catalog CLI gives
   * them (product `custom_data.paddle_kit = app`, price `custom_data.paddle_kit_price = "<key>-<cycle>"`), with
   * PADDLE_API_KEY, which becomes required. A set PADDLE_PRICES still wins: it is the override.
   */
  resolvePrices?: ResolvePricesOptions;
}

// Not watched: PADDLE_HEALTH_TOKEN and PADDLE_API_KEY (alone they do not mean "billing is being set up").
const WATCHED = [
  'PADDLE_ENV',
  'PADDLE_NOTIFICATION_WEBHOOK_SECRET',
  'PADDLE_PRICES',
  'NEXT_PUBLIC_PADDLE_CLIENT_TOKEN',
  'BILLING_LAUNCH_AT',
  'BILLING_ENFORCE',
] as const;

// ISO 8601 date-time with a mandatory timezone (Z or +hh:mm / +hhmm).
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

// A usable id/secret: non-empty and without leading/trailing whitespace (a pasted newline would silently break signatures and lookups).
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v === v.trim();
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parsePrice(v: unknown): string | Record<string, string> | null {
  if (nonEmpty(v)) return v;
  if (!isPlainObject(v)) return null;
  const entries = Object.entries(v);
  if (entries.length === 0 || !entries.every(([, id]) => nonEmpty(id))) return null;
  return Object.fromEntries(entries as [string, string][]);
}

/**
 * Read and validate the billing environment.
 * - Nothing in the watched set is set: `{ config: null, problems: [] }` (silent — safe at build time).
 * - Some set but invalid or incomplete: `config: null` and `problems` naming variables, never values.
 * - PADDLE_ENV defaults to `sandbox` when unset; any other unknown value is a problem.
 */
export function readBillingEnv(
  env: Record<string, string | undefined>,
  opts: ReadBillingEnvOptions & { resolvePrices: ResolvePricesOptions },
): { config: BillingEnvWithLookup | null; problems: string[] };
export function readBillingEnv(env: Record<string, string | undefined>, opts: ReadBillingEnvOptions): { config: BillingEnv | null; problems: string[] };
export function readBillingEnv(
  env: Record<string, string | undefined>,
  opts: ReadBillingEnvOptions,
): { config: BillingEnv | BillingEnvWithLookup | null; problems: string[] } {
  if (!WATCHED.some((name) => env[name])) return { config: null, problems: [] };
  const problems: string[] = [];

  let environment: BillingEnv['environment'] = 'sandbox';
  if (env.PADDLE_ENV) {
    if (env.PADDLE_ENV === 'sandbox' || env.PADDLE_ENV === 'production') environment = env.PADDLE_ENV;
    else problems.push('PADDLE_ENV must be "sandbox" or "production"');
  }

  const webhookSecret = env.PADDLE_NOTIFICATION_WEBHOOK_SECRET;
  // Several secrets, comma-separated, during a rotation. Paddle secrets never contain a comma.
  const webhookSecrets = webhookSecret?.split(',') ?? [];
  if (!webhookSecret?.trim()) problems.push('PADDLE_NOTIFICATION_WEBHOOK_SECRET is missing');
  else if (webhookSecrets.some((x) => x !== x.trim())) problems.push('PADDLE_NOTIFICATION_WEBHOOK_SECRET has leading or trailing whitespace');
  else if (!webhookSecrets.every(nonEmpty)) problems.push('PADDLE_NOTIFICATION_WEBHOOK_SECRET has an empty entry between commas');

  const resolving = opts.resolvePrices !== undefined && !env.PADDLE_PRICES;
  let prices: PriceMap | null = null;
  if (resolving) {
    prices = {};
    if (!env.PADDLE_API_KEY) problems.push('PADDLE_API_KEY is missing (needed to find the prices in Paddle while PADDLE_PRICES is unset)');
  } else if (!env.PADDLE_PRICES) {
    problems.push('PADDLE_PRICES is missing');
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.PADDLE_PRICES);
    } catch {
      parsed = undefined; // never echo the parser's message: it can quote the value
    }
    if (!isPlainObject(parsed)) {
      problems.push('PADDLE_PRICES is not a JSON object of price ids');
    } else {
      const map: PriceMap = {};
      let malformed = false;
      for (const [key, value] of Object.entries(parsed)) {
        const price = parsePrice(value);
        if (price === null) {
          if (opts.requiredPrices.includes(key)) problems.push(`PADDLE_PRICES entry "${key}" is not a price id or a map of cycle to price id`);
          else malformed = true;
        } else {
          map[key] = price;
        }
      }
      if (malformed) problems.push('PADDLE_PRICES has an entry that is not a price id or a map of cycle to price id');
      for (const key of opts.requiredPrices) {
        if (!Object.hasOwn(parsed, key)) problems.push(`PADDLE_PRICES is missing required price "${key}"`);
        else {
          const price = map[key];
          if (price !== undefined && typeof price !== 'string') {
            for (const cycle of opts.requiredCycles ?? []) {
              if (!Object.hasOwn(price, cycle)) problems.push(`PADDLE_PRICES entry "${key}" is missing cycle "${cycle}"`);
            }
          }
        }
      }
      prices = map;
    }
  }

  // With an invalid PADDLE_ENV the expected prefix is unknown: report only the root cause, not a derived mismatch.
  const envValid = !env.PADDLE_ENV || env.PADDLE_ENV === 'sandbox' || env.PADDLE_ENV === 'production';
  const clientToken = env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN ?? '';
  if (!clientToken.trim()) problems.push('NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is missing');
  else if (clientToken !== clientToken.trim()) problems.push('NEXT_PUBLIC_PADDLE_CLIENT_TOKEN has leading or trailing whitespace');
  else if (envValid && !clientToken.startsWith(environment === 'production' ? 'live_' : 'test_'))
    problems.push('NEXT_PUBLIC_PADDLE_CLIENT_TOKEN does not match PADDLE_ENV (test_ = sandbox, live_ = production)');

  let launchAt: number | null = null;
  if (env.BILLING_LAUNCH_AT) {
    const ms = ISO_WITH_ZONE.test(env.BILLING_LAUNCH_AT) ? Date.parse(env.BILLING_LAUNCH_AT) : Number.NaN;
    if (Number.isNaN(ms)) problems.push('BILLING_LAUNCH_AT is not an ISO date-time with a timezone (e.g. 2026-10-20T00:00:00Z)');
    else launchAt = ms;
  } else if (opts.requireLaunchAt) {
    problems.push('BILLING_LAUNCH_AT is missing');
  }

  const healthToken = env.PADDLE_HEALTH_TOKEN;
  if (healthToken && healthToken !== healthToken.trim()) problems.push('PADDLE_HEALTH_TOKEN has leading or trailing whitespace');

  const apiKey = env.PADDLE_API_KEY || undefined;
  if (apiKey && envValid && !apiKey.startsWith(environment === 'production' ? 'pdl_live_' : 'pdl_sdbx_'))
    problems.push('PADDLE_API_KEY does not match PADDLE_ENV (pdl_sdbx_ = sandbox, pdl_live_ = production)');

  if (problems.length > 0 || !nonEmpty(webhookSecret) || !prices) return { config: null, problems };
  const config: BillingEnv = {
    environment,
    webhookSecret: webhookSecrets[0]!,
    webhookSecrets,
    prices,
    clientToken,
    launchAt,
    enforce: env.BILLING_ENFORCE === '1',
  };
  if (env.PADDLE_HEALTH_TOKEN) config.healthToken = env.PADDLE_HEALTH_TOKEN; // whitespace rejected above
  if (apiKey) config.apiKey = apiKey;
  const priceIds = priceIdsOf(prices);
  const lookup = opts.resolvePrices;
  if (!lookup) {
    if (priceIds.length > 0) config.owns = { priceIds };
    return { config, problems };
  }
  const fixed = prices;
  const resolvePrices = resolving
    ? memo(async () => checkRequired(await findPriceMap(lookup.app, { apiKey: apiKey!, environment, fetch: lookup.fetch, timeoutMs: lookup.timeoutMs }), lookup.app, opts), (lookup.cacheSeconds ?? 600) * 1000)
    : async () => fixed;
  const withLookup: BillingEnvWithLookup = { ...config, resolvePrices };
  if (resolving) withLookup.owns = { resolve: async () => ({ priceIds: priceIdsOf(await resolvePrices()) }) };
  else if (priceIds.length > 0) withLookup.owns = { priceIds };
  return { config: withLookup, problems };
}

const priceIdsOf = (prices: PriceMap) => [...new Set(Object.values(prices).flatMap((p) => (typeof p === 'string' ? [p] : Object.values(p))))];

/** The required keys and cycles of a map found in Paddle, checked like PADDLE_PRICES is. */
function checkRequired(map: PriceMap, app: string, opts: ReadBillingEnvOptions): PriceMap {
  for (const key of opts.requiredPrices) {
    const price = map[key];
    if (price === undefined) throw new PriceError('not_found', `app "${app}" has no active price labelled "${key}-…" in Paddle (run paddle-kit-catalog)`);
    if (typeof price === 'string') continue;
    for (const cycle of opts.requiredCycles ?? []) {
      if (!Object.hasOwn(price, cycle)) throw new PriceError('not_found', `app "${app}" has no active price labelled "${key}-${cycle}" in Paddle`);
    }
  }
  return map;
}

/** `fn`, with a success kept for `ms` and shared by concurrent callers. A failure is dropped at once, so the next call retries. */
function memo<T>(fn: () => Promise<T>, ms: number): () => Promise<T> {
  let kept: { at: number; value: Promise<T> } | null = null;
  return () => {
    const at = Date.now();
    if (kept && at - kept.at < ms) return kept.value;
    const value = fn();
    const entry = { at, value };
    kept = entry;
    value.catch(() => {
      if (kept === entry) kept = null;
    });
    return value;
  };
}
