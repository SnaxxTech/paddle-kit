// Billing environment validation. Pure and edge-safe (no node: imports, no runtime deps).
// Problem strings name variables (and caller-supplied price keys) only, never values.

/** key -> price id, or key -> { billing cycle -> price id }. */
export type PriceMap = Record<string, string | Record<string, string>>;

export interface BillingEnv {
  environment: 'sandbox' | 'production';
  webhookSecret: string;
  prices: PriceMap;
  clientToken: string;
  /** Epoch ms, or null when BILLING_LAUNCH_AT is unset and not required. */
  launchAt: number | null;
  enforce: boolean;
  healthToken?: string;
  apiKey?: string;
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

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
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
  opts: ReadBillingEnvOptions,
): { config: BillingEnv | null; problems: string[] } {
  if (!WATCHED.some((name) => env[name])) return { config: null, problems: [] };
  const problems: string[] = [];

  let environment: BillingEnv['environment'] = 'sandbox';
  if (env.PADDLE_ENV) {
    if (env.PADDLE_ENV === 'sandbox' || env.PADDLE_ENV === 'production') environment = env.PADDLE_ENV;
    else problems.push('PADDLE_ENV must be "sandbox" or "production"');
  }

  const webhookSecret = env.PADDLE_NOTIFICATION_WEBHOOK_SECRET;
  if (!nonEmpty(webhookSecret)) problems.push('PADDLE_NOTIFICATION_WEBHOOK_SECRET is missing');

  let prices: PriceMap | null = null;
  if (!env.PADDLE_PRICES) {
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

  const apiKey = env.PADDLE_API_KEY || undefined;
  if (apiKey && envValid && !apiKey.startsWith(environment === 'production' ? 'pdl_live_' : 'pdl_sdbx_'))
    problems.push('PADDLE_API_KEY does not match PADDLE_ENV (pdl_sdbx_ = sandbox, pdl_live_ = production)');

  if (problems.length > 0 || !nonEmpty(webhookSecret) || !prices) return { config: null, problems };
  const config: BillingEnv = {
    environment,
    webhookSecret,
    prices,
    clientToken,
    launchAt,
    enforce: env.BILLING_ENFORCE === '1',
  };
  if (env.PADDLE_HEALTH_TOKEN) config.healthToken = env.PADDLE_HEALTH_TOKEN;
  if (apiKey) config.apiKey = apiKey;
  return { config, problems };
}
