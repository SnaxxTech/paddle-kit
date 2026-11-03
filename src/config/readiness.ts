// Deploy-time readiness checks for the health route (since v0.8.2). Edge-safe: web fetch only.
// Details name permissions, migrations and variables only, never a value.
import { LIVE_BASE, PADDLE_API_VERSION, SANDBOX_BASE, type FetchLike } from '../core/paddle-api';
import type { CheckResult, Store } from '../core/types';

/** What `recoverBilling` reads. */
const RECOVERY_PERMISSIONS = ['notification.read', 'subscription.read', 'transaction.read', 'adjustment.read'];
/** What price lookup by label (`resolvePrices`, `syncOwnership`) reads. */
const PRICE_PERMISSIONS = ['price.read', 'product.read'];

export interface ReadinessOptions {
  /** PADDLE_API_KEY. */
  apiKey: string | undefined;
  environment: 'sandbox' | 'production';
  /** The app's store: checks migrations 003 and 004. */
  store?: Store;
  /** Permissions the app needs beyond recovery, e.g. `subscription.write` for plan changes. */
  permissions?: readonly string[];
  /** The app finds prices by label: `price.read` and `product.read` are needed too. */
  resolvesPrices?: boolean;
  /** `process.env.CRON_SECRET`. Pass the key (even when unset) to check it; leave it out to skip. */
  cronSecret?: string | undefined;
  fetch?: FetchLike;
  /** How long a good answer from Paddle is reused. Default 600 s; a failure is asked again after 60 s. */
  cacheSeconds?: number;
  now?: () => number;
}

/**
 * Health checks for `createBilling({ healthChecks })`, or `billingFromEnv({ readiness })`:
 * - `paddle_api_key`: one `GET /` to Paddle (cached): the key is accepted, is for this environment, and has the
 *   permissions recovery (and price lookup, and `permissions`) need;
 * - `migrations`: the store answers for `003_recovery` and `004_claim_tokens_owned_ids` (when `store` is given);
 * - `cron_secret`: CRON_SECRET is set and at least 16 characters (when `cronSecret` is passed).
 * A failing check turns the health report and `paddle-kit-doctor` red, with the detail.
 */
export function readinessChecks(opts: ReadinessOptions): Record<string, () => Promise<CheckResult>> {
  const now = opts.now ?? Date.now;
  const fetchImpl: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const needed = [...new Set([...RECOVERY_PERMISSIONS, ...(opts.resolvesPrices ? PRICE_PERMISSIONS : []), ...(opts.permissions ?? [])])];
  let cached: { at: number; result: CheckResult } | null = null;

  async function askPaddle(): Promise<CheckResult> {
    if (!opts.apiKey) return { ok: false, detail: 'PADDLE_API_KEY is missing' };
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchImpl(`${opts.environment === 'production' ? LIVE_BASE : SANDBOX_BASE}/`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Paddle-Version': String(PADDLE_API_VERSION) },
        redirect: 'error',
      });
    } catch {
      return { ok: false, detail: 'Paddle did not answer' };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, detail: `Paddle refused the API key (${res.status}): wrong, revoked, or a key of the other environment` };
    if (!res.ok) return { ok: false, detail: `Paddle answered ${res.status}` };
    const data = ((await res.json().catch(() => null)) as { data?: { api?: { environment?: string }; caller?: { permissions?: unknown } } } | null)?.data;
    const keyEnv = data?.api?.environment;
    if (keyEnv && keyEnv !== opts.environment) return { ok: false, detail: `the API key is for ${keyEnv}, the app runs ${opts.environment}` };
    const have = Array.isArray(data?.caller?.permissions) ? (data!.caller!.permissions as unknown[]) : null;
    if (!have) return { ok: false, detail: 'Paddle did not list the key\'s permissions' };
    const missing = needed.filter((p) => !have.includes(p));
    return missing.length > 0 ? { ok: false, detail: `missing permissions: ${missing.join(', ')}` } : { ok: true, detail: `${needed.length} permissions present` };
  }

  const checks: Record<string, () => Promise<CheckResult>> = {
    async paddle_api_key() {
      const ttl = (cached?.result.ok ? (opts.cacheSeconds ?? 600) : 60) * 1000;
      if (cached && now() - cached.at < ttl) return cached.result;
      const result = await askPaddle();
      cached = { at: now(), result };
      return result;
    },
  };

  if (opts.store) {
    const store = opts.store;
    checks.migrations = async () => {
      try {
        if (!store.recovery) return { ok: false, detail: 'migration 003_recovery is missing' };
        await store.recovery.getRecovery(opts.environment);
      } catch {
        return { ok: false, detail: 'migration 003_recovery is missing' };
      }
      try {
        if (!store.getOwnedIds) return { ok: false, detail: 'migration 004_claim_tokens_owned_ids is missing' };
        await store.getOwnedIds();
      } catch {
        return { ok: false, detail: 'migration 004_claim_tokens_owned_ids is missing' };
      }
      return { ok: true };
    };
  }

  if ('cronSecret' in opts) {
    checks.cron_secret = async () => {
      if (!opts.cronSecret) return { ok: false, detail: 'CRON_SECRET is missing' };
      if (opts.cronSecret.length < 16) return { ok: false, detail: 'CRON_SECRET is shorter than 16 characters' };
      return { ok: true };
    };
  }
  return checks;
}
