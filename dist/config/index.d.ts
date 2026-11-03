import { FetchLike } from '../catalog/index.js';
import { BillingConfig, Billing } from '../core/index.js';
import { PaddleTransport } from '../core/index.js';
import { OwnsResolver } from '../core/index.js';

/** key -> price id, or key -> { billing cycle -> price id }. */
type PriceMap = Record<string, string | Record<string, string>>;
interface BillingEnv {
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
    owns?: {
        priceIds: string[];
    };
}
/** What `readBillingEnv` returns with the `resolvePrices` option (since v0.7.0). */
interface BillingEnvWithLookup extends Omit<BillingEnv, 'owns'> {
    /**
     * PADDLE_PRICES set: every id in it, as without the option. Unset: a resolver over `resolvePrices`, which
     * `createBilling` awaits per event (a failed lookup answers 503, never `not_ours`). Pass it the same way: `owns: config.owns`.
     */
    owns?: {
        priceIds: string[];
    } | OwnsResolver;
    /**
     * The price map: PADDLE_PRICES when it is set (no request), else found in Paddle by label (`findPriceMap`) and checked
     * against `requiredPrices` / `requiredCycles`. A found map is kept for `cacheSeconds` in this server instance; a
     * failure is not kept, so the next call asks again. Throws `PriceError`.
     */
    resolvePrices: () => Promise<PriceMap>;
}
interface ResolvePricesOptions {
    /** The catalog's `app`. */
    app: string;
    /** How long a found map is kept in this server instance. Default 600 (10 min). */
    cacheSeconds?: number;
    fetch?: FetchLike;
    /** Per lookup. Default 5000. */
    timeoutMs?: number;
}
interface ReadBillingEnvOptions {
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
/**
 * Read and validate the billing environment.
 * - Nothing in the watched set is set: `{ config: null, problems: [] }` (silent — safe at build time).
 * - Some set but invalid or incomplete: `config: null` and `problems` naming variables, never values.
 * - PADDLE_ENV defaults to `sandbox` when unset; any other unknown value is a problem.
 */
declare function readBillingEnv(env: Record<string, string | undefined>, opts: ReadBillingEnvOptions & {
    resolvePrices: ResolvePricesOptions;
}): {
    config: BillingEnvWithLookup | null;
    problems: string[];
};
declare function readBillingEnv(env: Record<string, string | undefined>, opts: ReadBillingEnvOptions): {
    config: BillingEnv | null;
    problems: string[];
};
type BillingFromEnvOptions = ReadBillingEnvOptions & Omit<BillingConfig, 'environment' | 'webhookSecret' | 'healthToken' | 'owns' | 'entitlements' | 'catalogApp'> & {
    /** Price id → features, or a function of the config that builds it from the price ids. Default `{}` (one-time sales only). */
    entitlements?: BillingConfig['entitlements'] | ((config: BillingEnv | BillingEnvWithLookup) => BillingConfig['entitlements']);
    /**
     * Default: every id in PADDLE_PRICES; with `resolvePrices` (PADDLE_PRICES unset), the ids kept in the store
     * (`syncOwnership`, run by the recovery job: archived prices included), or the live resolver for a store without
     * `getOwnedIds`.
     */
    owns?: BillingConfig['owns'];
};
/**
 * The whole setup in one call: `readBillingEnv`, then `createBilling` only when the env is valid, with the env's
 * environment, every webhook secret, the health token and `owns` filled in. `billing` is null while billing is off or
 * misconfigured (then `problems` names the variables), so it is safe at module scope in a build without secrets:
 * `export const { billing, config, problems } = billingFromEnv(process.env, { requiredPrices: ['pro'], store, … })`.
 * Since v0.8.0 the safe path is the default: price lookups and `recoverBilling` go through one resilient transport
 * (`transport`, also `billing.config.paddleFetch`), and with `resolvePrices` ownership is read from the store.
 */
declare function billingFromEnv(env: Record<string, string | undefined>, opts: BillingFromEnvOptions): {
    billing: Billing | null;
    config: BillingEnv | BillingEnvWithLookup | null;
    problems: string[];
    /**
     * Since v0.8.0: BILLING_ENFORCE === '1', read even when the rest of the env is broken. With `billing` null and
     * `enforce` true, paid operations must be refused, never served free: a broken config never unlocks them.
     */
    enforce: boolean;
    transport?: PaddleTransport;
};

export { billingFromEnv, readBillingEnv };
export type { BillingEnv, BillingEnvWithLookup, BillingFromEnvOptions, PriceMap, ReadBillingEnvOptions, ResolvePricesOptions };
