// Deploy-time readiness checks for the health route (since v0.8.2). Edge-safe: web fetch only.
// Details name permissions, migrations and variables only, never a value.
import { LIVE_BASE, PADDLE_API_VERSION, SANDBOX_BASE, paddleClient, type FetchLike } from '../core/paddle-api';
import { FULFILMENT_SCHEMA, MIGRATION_OF_TABLE } from '../core/schema';
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
  /** The app uses `paddle-kit/fulfil`: its tables (migration 005) are checked too. Since v0.8.6. */
  fulfilment?: boolean;
  /**
   * Retired price ids (since v0.9.2; `billingFromEnv` passes the products' `retiredPriceIds`): `retired_prices` is red
   * while one is still active in Paddle, because Paddle.js can open a checkout for any active price. Needs `price.read`.
   */
  retiredPriceIds?: readonly string[];
  /** `process.env.CRON_SECRET`. Pass the key (even when unset) to check it; leave it out to skip. */
  cronSecret?: string | undefined;
  fetch?: FetchLike;
  /**
   * How long a good answer from Paddle is reused, per server instance (not fleet-wide). Default 600 s; a failure is
   * asked again after 60 s. Simultaneous checks on one instance share one request.
   */
  cacheSeconds?: number;
  now?: () => number;
}

/**
 * Health checks for `createBilling({ healthChecks })`, or `billingFromEnv({ readiness })`:
 * - `paddle_api_key`: one `GET /` to Paddle (cached): the key is accepted, is for this environment, and has the
 *   permissions recovery (and price lookup, and `permissions`) need;
 * - `migrations`: every table and column the kit needs (`REQUIRED_SCHEMA`) is there (when `store` is given; the
 *   built-in Postgres and SQLite stores check `information_schema` / `pragma_table_info`). A database that does not
 *   answer is reported as such, not as a missing migration. The Postgres check sees only what the connection's role
 *   may see, in its current schema;
 * - `cron_secret`: CRON_SECRET is set and at least 16 characters (when `cronSecret` is passed).
 * A failing check turns the health report and `paddle-kit-doctor` red, with the detail.
 */
export function readinessChecks(opts: ReadinessOptions): Record<string, () => Promise<CheckResult>> {
  const now = opts.now ?? Date.now;
  const fetchImpl: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const retired = [...new Set(opts.retiredPriceIds ?? [])];
  const needed = [...new Set([...RECOVERY_PERMISSIONS, ...(opts.resolvesPrices ? PRICE_PERMISSIONS : []), ...(retired.length > 0 ? ['price.read'] : []), ...(opts.permissions ?? [])])];
  let cached: { at: number; result: CheckResult } | null = null;
  // Per server instance: simultaneous health checks share one request; other instances ask Paddle on their own.
  let inFlight: Promise<CheckResult> | null = null;

  async function askPaddle(): Promise<CheckResult> {
    if (!opts.apiKey) return { ok: false, detail: 'PADDLE_API_KEY is missing' };
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchImpl(`${opts.environment === 'production' ? LIVE_BASE : SANDBOX_BASE}/`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Paddle-Version': String(PADDLE_API_VERSION) },
        redirect: 'manual', // Cloudflare Workers rejects 'error'; a 3xx is not ok and reported below
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
      inFlight ??= askPaddle()
        .then((result) => {
          cached = { at: now(), result };
          return result;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };

  if (opts.store) {
    const store = opts.store;
    checks.migrations = async () => {
      if (store.checkSchema) {
        let missing: string[];
        try {
          ({ missing } = await store.checkSchema(opts.fulfilment ? FULFILMENT_SCHEMA : undefined));
        } catch {
          return { ok: false, detail: 'the store did not answer (connection or permissions), so the schema was not checked' };
        }
        if (missing.length === 0) return { ok: true };
        const migrations = [...new Set(missing.map((m) => MIGRATION_OF_TABLE[m.split('.')[0]!]).filter(Boolean))];
        return { ok: false, detail: `missing ${missing.join(', ')} (run ${migrations.join(', ')})` };
      }
      // A custom store without checkSchema: read what recovery and ownership need. This cannot tell a missing table
      // from a database that does not answer, and does not see the claim table.
      try {
        if (!store.recovery || !store.getOwnedIds) return { ok: false, detail: 'the store has no recovery or owned ids (migrations 003, 004)' };
        await store.recovery.getRecovery(opts.environment);
        await store.getOwnedIds();
        return { ok: true, detail: 'partly checked: the store has no checkSchema' };
      } catch {
        return { ok: false, detail: 'reading paddle_recovery or paddle_owned_ids failed (migration 003/004 missing, or the store did not answer)' };
      }
    };
  }

  if (retired.length > 0) {
    let good: { at: number; result: CheckResult } | null = null;
    checks.retired_prices = async () => {
      if (good && now() - good.at < (opts.cacheSeconds ?? 600) * 1000) return good.result;
      if (!opts.apiKey) return { ok: false, detail: 'PADDLE_API_KEY is missing, so retired prices were not checked' };
      const api = paddleClient(opts.environment === 'production' ? LIVE_BASE : SANDBOX_BASE, opts.apiKey, fetchImpl, [opts.apiKey]);
      const onSale: string[] = [];
      try {
        for (const id of retired) if ((await api.call('GET', `/prices/${encodeURIComponent(id)}`)).data?.status !== 'archived') onSale.push(id);
      } catch {
        return { ok: false, detail: 'Paddle did not answer, so retired prices were not checked' };
      }
      if (onSale.length > 0) return { ok: false, detail: `still on sale in Paddle: ${onSale.join(', ')} (archive retired prices: Paddle.js can open a checkout for any active price)` };
      const result = { ok: true, detail: `${retired.length} retired price${retired.length === 1 ? '' : 's'} archived` };
      good = { at: now(), result };
      return result;
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
