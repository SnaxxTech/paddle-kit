import { F as FetchLike } from '../billing-p4GDaELW.js';
import { Billing } from '../core/index.js';
import { RecoveryStore } from '../core/index.js';

/**
 * Re-reads every subscription from the Paddle API and upserts it into the mirror, through the same mapping as the
 * webhook path. Each row carries the API's `updated_at`, so a webhook that occurred later still wins. Web fetch only.
 * `invalid` counts entities the webhook path would also reject (unknown status, missing ids).
 */
declare function reconcile(billing: Billing, opts: {
    apiKey: string;
    fetch?: FetchLike;
    signal?: AbortSignal;
}): Promise<{
    scanned: number;
    applied: number;
    notOurs: number;
    invalid: number;
}>;
/**
 * Keeps every price and product of `app` (the catalog CLI's product label), active AND archived, in the store's owned
 * ids, so a late payment or renewal on a price the app no longer sells is still recognised as its own. Adds only:
 * an id once owned stays owned. `recoverBilling` runs it first when `billing.config.catalogApp` is set.
 */
declare function syncOwnership(billing: Billing, opts: {
    apiKey: string;
    app: string;
    fetch?: FetchLike;
    signal?: AbortSignal;
}): Promise<{
    priceIds: number;
    productIds: number;
}>;
interface PaymentCounts {
    /** Entities read from the API. */
    scanned: number;
    /** Replayed now: processed (hooks ran), or stale. */
    applied: number;
    /** Already replayed by an earlier run (the ledger row exists). */
    duplicates: number;
    /** Another product's (shared seller account). */
    notOurs: number;
    /** The replay failed (a hook threw, the store or the price lookup failed). Run again later. */
    failed: number;
    /**
     * Since v0.8.0: entities that could not be judged (no valid `updated_at` / `created_at`), so they were neither
     * replayed nor skipped as old. Never silent: `recoverBilling` reports the run incomplete and keeps its checkpoint.
     */
    invalid: number;
}
/**
 * Repairs missed payment and refund webhooks: reads completed transactions updated since `since`, and adjustments
 * updated since then, from the Paddle API and replays each through the webhook's own ledger path, as a delivery with
 * its own event id (`reconcile_txn_<id>`, `reconcile_adj_<id>_<status>`). So `owns`, `onTransaction`,
 * `onAdjustment`, the claims and the dedup apply exactly as for a webhook, and a second run is a no-op.
 * A payment the webhook already processed runs its hook once more (at least once): hooks must be idempotent anyway.
 * Adjustments come after transactions, and an adjustment of a transaction the store never saw first replays that
 * transaction, so a refund is never judged without its payment. Web fetch only (edge-safe).
 */
declare function reconcilePayments(billing: Billing, opts: {
    apiKey: string;
    since: Date | string;
    fetch?: FetchLike;
    signal?: AbortSignal;
}): Promise<{
    transactions: PaymentCounts;
    adjustments: PaymentCounts;
}>;
interface RecoveryOptions {
    apiKey: string;
    fetch?: FetchLike;
    /** A stable name scoped to this billing environment. Default environment. */
    name?: string;
    /** First successful run covers all history by default. Never silently rolls forward after an outage. */
    initialSince?: Date;
    overlapMs?: number;
    timeoutMs?: number;
    pendingLimit?: number;
    /** Must exceed the longest configured webhook claim lease. Default 5 minutes. */
    pendingAgeMs?: number;
    store?: RecoveryStore;
    now?: () => Date;
}
/**
 * What an incomplete run did, so the reason is visible (since v0.8.0): failed replays, `invalid` records (no valid
 * time: a person looks), unfinished events still waiting, and no owned ids found (`ownership` all zero).
 */
interface IncompleteDetail {
    subscriptions: Awaited<ReturnType<typeof reconcile>>;
    payments: Awaited<ReturnType<typeof reconcilePayments>>;
    events: {
        applied: number;
        failed: number;
    };
    remainingPending: number;
    ownership?: {
        priceIds: number;
        productIds: number;
    };
}
type RecoveryResult = {
    status: 'busy';
} | ({
    status: 'failed';
    reason: 'incomplete' | 'timeout' | 'recovery_error' | 'api_error' | 'network' | 'circuit_open';
    httpStatus?: number;
} & Partial<IncompleteDetail>) | {
    status: 'done';
    since: string;
    subscriptions: Awaited<ReturnType<typeof reconcile>>;
    payments: Awaited<ReturnType<typeof reconcilePayments>>;
    events: {
        applied: number;
        failed: number;
    };
    /** Since v0.8.0, when `billing.config.catalogApp` is set: the owned ids `syncOwnership` found. */
    ownership?: {
        priceIds: number;
        productIds: number;
    };
};
/**
 * Durable self-repair: reclaim an expired job lease, replay unfinished original events, repair snapshots/payments,
 * and advance the checkpoint only after ALL work succeeds. Partial work is safe to retry through the same ledger.
 * Use one runner from an authenticated cron. This does not create a scheduler or retry irreversible app side effects.
 */
declare function recoverBilling(billing: Billing, opts: RecoveryOptions): Promise<RecoveryResult>;
interface RecoveryRouteOptions {
    /** `null` when billing is off or misconfigured. */
    billing: Billing | null;
    /** `problems` from `readBillingEnv` / `billingFromEnv`. */
    problems: readonly string[];
    /** `config.apiKey` (PADDLE_API_KEY). */
    apiKey: string | undefined;
    /** `process.env.CRON_SECRET`. Unset or empty: every call is refused, so a missing secret never opens the job. */
    cronSecret: string | undefined;
    /** Passed to `recoverBilling` (limits, `fetch`, `now`). */
    recovery?: Omit<RecoveryOptions, 'apiKey'>;
}
/**
 * The scheduled recovery job as a route (since v0.8.1):
 * `export const { GET } = createRecoveryRoute({ billing, problems, apiKey: config?.apiKey, cronSecret: process.env.CRON_SECRET })`.
 * - `Authorization` must be `Bearer <cronSecret>` (Vercel Cron sends it); otherwise, or with no secret set, 401.
 * - Billing deliberately off (no billing variable, `problems` empty): 200 `{ status: "off" }`.
 * - Misconfigured (`problems`, or billing on without an API key): 500 `{ status: "misconfigured", problems }`, names only.
 * - Otherwise `recoverBilling`: 500 when the run failed, 200 when it is done or another run holds the lease.
 */
declare function createRecoveryRoute(opts: RecoveryRouteOptions): {
    GET: (req: Request) => Promise<Response>;
};

export { FetchLike, createRecoveryRoute, reconcile, reconcilePayments, recoverBilling, syncOwnership };
export type { IncompleteDetail, PaymentCounts, RecoveryOptions, RecoveryResult, RecoveryRouteOptions };
