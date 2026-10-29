/** key -> price id, or key -> { billing cycle -> price id }. */
type PriceMap = Record<string, string | Record<string, string>>;
interface BillingEnv {
    environment: 'sandbox' | 'production';
    webhookSecret: string;
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
}
/**
 * Read and validate the billing environment.
 * - Nothing in the watched set is set: `{ config: null, problems: [] }` (silent — safe at build time).
 * - Some set but invalid or incomplete: `config: null` and `problems` naming variables, never values.
 * - PADDLE_ENV defaults to `sandbox` when unset; any other unknown value is a problem.
 */
declare function readBillingEnv(env: Record<string, string | undefined>, opts: ReadBillingEnvOptions): {
    config: BillingEnv | null;
    problems: string[];
};

export { readBillingEnv };
export type { BillingEnv, PriceMap, ReadBillingEnvOptions };
