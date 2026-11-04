import { BillingConfig } from '../core/index.js';
import { Transaction, CheckResult } from '../core/index.js';
import '../paddle-api-CrEnAa2Z.js';

/** One query on the app's Postgres client: pg, @neondatabase/serverless Pool, postgres-js wrapper, PGlite. */
interface SqlTx {
    query(text: string, params?: unknown[]): Promise<{
        rows: any[];
    }>;
}
/** A client that runs `fn` in one real transaction (BEGIN … COMMIT, ROLLBACK when it throws). */
interface SqlDb {
    transaction<T>(fn: (q: SqlTx) => Promise<T>): Promise<T>;
}
interface Fulfilment<G> {
    transactionId: string;
    userId: string;
    /** What the payment grants, as `orderOf` returned it (stored as JSON). */
    grants: G;
}
/** The adjustment that made the kit call `revoke` or `restore` (since v0.8.6). */
interface FulfilmentCause {
    adjustmentId: string;
    action: string;
    status: string;
    type: string | null;
}
interface FulfilmentActions<G> {
    /**
     * What a completed one-time payment grants, or `null` when it is not one the app fulfils by itself (no user, a price
     * of nothing it sells): then a review row keeps the paid order visible for a person. Runs inside the payment's lock
     * and the app's transaction (`q`), so it may read the database; it may be async. `customData.userId` is untrusted
     * (the most a user can do is pay for someone else); prefer a server-created checkout.
     */
    orderOf(tx: Transaction, q: SqlTx): {
        userId: string;
        grants: G;
    } | null | Promise<{
        userId: string;
        grants: G;
    } | null>;
    /**
     * Gives the payment's `grants` to the user. Runs once per payment (again only after a restore). Return
     * `{ declined: reason }` to refuse after checking under the lock (say, the order was already paid by another
     * transaction): the payment is then `declined`, a `declined:<reason>` review is written, and its later refunds and
     * chargebacks change nothing.
     */
    grant(q: SqlTx, f: Fulfilment<G>): Promise<void | {
        declined: string;
    }>;
    /**
     * Takes the payment back (a full refund or a chargeback that stands). Return what was actually taken (credits
     * already spent are gone): it is stored and handed to `restore`. Return `null` when there is nothing to measure.
     * `cause` is the adjustment that made it stand.
     */
    revoke(q: SqlTx, f: Fulfilment<G> & {
        cause: FulfilmentCause;
    }): Promise<unknown>;
    /** Gives back exactly what `revoke` took, when the refund or chargeback is reversed (`cause`). */
    restore(q: SqlTx, f: Fulfilment<G> & {
        taken: unknown;
        cause: FulfilmentCause;
    }): Promise<void>;
}
/** A row of `paddle_fulfilment_reviews`, as `onReview` receives it. */
interface FulfilmentReview {
    id: string;
    transactionId: string;
    kind: string;
    detail: string;
}
interface FulfilmentOptions {
    /**
     * Called once for each new review row, in the same transaction (since v0.8.6): route it to the app's own alerting.
     * Kinds: `unfulfilled_payment`, `declined:<reason>`, `held_payment`, and the adjustment action of a partial refund
     * or a chargeback warning (`refund`, `chargeback_warning`, …).
     */
    onReview?(q: SqlTx, review: FulfilmentReview): Promise<void>;
}
type FulfilmentStateName = 'held' | 'granted' | 'revoked' | 'declined';
type AdjustmentRow = {
    action: string;
    type: string | null;
    status: string;
};
/**
 * Reads a payment's fulfilment (since v0.8.6): `null` when the kit has no row for it. `revokedBy` says what takes it
 * back now (also for a `held` payment whose refund or chargeback came first). For a checkout confirmation ("refunded",
 * "charged back") or a reconcile report; run it in a transaction to read a settled state.
 */
declare function fulfilmentState(q: SqlTx, transactionId: string): Promise<{
    state: FulfilmentStateName;
    userId: string;
    grants: unknown;
    taken: unknown;
    revokedBy: 'refund' | 'chargeback' | null;
    adjustments: AdjustmentRow[];
} | null>;
/**
 * Brings a payment fulfilled before the app used the kit into its tables (since v0.8.6), so a later refund is honoured
 * and a refunded order is not given back by an unrelated event. `state: 'revoked'` needs `revokedBy` and the Paddle
 * `adjustmentId` that took it back (since v0.8.7; `GET /adjustments?transaction_id=…`): it is recorded as that
 * approved refund or chargeback, so only its own reversal gives the order back, and a replay of it counts once.
 * Import only an adjustment Paddle shows as `approved`, and pass `taken` (what `restore` gives back on a reversal).
 * Run it in a transaction (two writes). Returns false when the kit already has the payment (nothing changes). Run it in a migration or a one-off script.
 */
declare function importFulfilment(q: SqlTx, o: {
    transactionId: string;
    userId: string;
    grants: unknown;
    state: 'granted';
} | {
    transactionId: string;
    userId: string;
    grants: unknown;
    state: 'revoked';
    revokedBy: 'refund' | 'chargeback';
    adjustmentId: string;
    taken?: unknown;
}): Promise<boolean>;
/**
 * `onTransaction` and `onAdjustment` hooks for `createBilling` / `billingFromEnv`. Each payment's changes run one at
 * a time (a transaction-scoped advisory lock on its id) and inside the app's own database transaction, so a payment,
 * its refunds and chargebacks can arrive in any order, twice, or at the same moment and still end in one state:
 * - a refund or chargeback that arrived before its payment: the payment grants nothing until it is reversed (a
 *   `held_payment` review says so);
 * - a reversal gives back what the revoke took, never more (spent credits stay spent);
 * - a partial refund or a chargeback warning becomes a review row (a person decides); so does a paid order `orderOf`
 *   does not fulfil, and one `grant` declines. Subscription payments are left to entitlements.
 */
declare function createFulfilment<G>(db: SqlDb, actions: FulfilmentActions<G>, options?: FulfilmentOptions): Pick<BillingConfig, 'onTransaction' | 'onAdjustment'>;
/**
 * Queues a side effect (an email, a job) in the caller's transaction, so it is sent only if the payment's changes
 * commit. `id` is the idempotency key (e.g. `${transactionId}:receipt`): a retried webhook adds nothing.
 */
declare function enqueue(q: SqlTx, item: {
    id: string;
    kind: string;
    payload: unknown;
}): Promise<void>;
interface OutboxHandlers {
    [kind: string]: (payload: any, item: {
        id: string;
        attempts: number;
    }) => Promise<void>;
}
interface DrainOptions {
    /** Items per run. Default 20. */
    limit?: number;
    /** After this many failed attempts an item stops being retried (it stays visible in `outboxCheck`). Default 8. */
    maxAttempts?: number;
    /** How long a claimed item is hidden from other runs while it is being sent. Default 120 s. */
    leaseSeconds?: number;
    /** No item is claimed after this many ms since the run started (since v0.9.0; default 20 s): bounded per run. */
    budgetMs?: number;
    /**
     * A handler not done after this many ms counts as a failed attempt and is retried later (since v0.9.2; default:
     * no limit). It is not cancelled and may still finish, so handlers stay idempotent on `item.id`; give your provider
     * call its own timeout too. A run then takes at most about `budgetMs` + `handlerTimeoutMs`.
     */
    handlerTimeoutMs?: number;
}
/**
 * Sends due outbox items at least once: claims one due item at a time (other runs skip it for `leaseSeconds`), calls
 * the handler for its kind, marks it sent, or schedules a retry with exponential backoff (1 min, 2, 4, … 6 h).
 * Since v0.8.7: each claim counts as an attempt; a failure changes the row only while that claim still holds it, so a
 * worker that ran past its lease cannot overwrite the retry state of the run that took the item over (`lost` counts
 * those); a send that finished is always marked sent.
 * A handler that runs past `leaseSeconds` can be called again by another run, and a crash after sending sends it again:
 * handlers must be idempotent on `item.id` (pass it as the idempotency key of the email or API call). Call it right
 * after the payment commits, and hourly as the backstop (`createOutboxRoute`, or `createRecoveryRoute({ drainOutbox })`).
 * Errors are stored redacted and cut to 200 characters.
 */
declare function drainOutbox(query: SqlTx['query'], handlers: OutboxHandlers, o?: DrainOptions): Promise<{
    sent: number;
    failed: number;
    gaveUp: number;
    lost: number;
}>;
/**
 * A health check (`createBilling({ healthChecks: { outbox: outboxCheck(query) } })`): red when an item gave up, or has
 * waited longer than `maxAgeMinutes` (default 60) unsent. The detail counts them and names the oldest item's kind.
 */
declare function outboxCheck(query: SqlTx['query'], o?: {
    maxAgeMinutes?: number;
    maxAttempts?: number;
}): () => Promise<CheckResult>;
/**
 * A health check (since v0.9.0): red while a fulfilment review is unresolved (a paid order nobody fulfilled, a
 * declined grant, a partial refund or a chargeback warning: each needs a person). `resolveReview` clears one.
 */
declare function reviewsCheck(query: SqlTx['query']): () => Promise<CheckResult>;
/** Marks a review handled (since v0.9.0). False when it does not exist or was already resolved. */
declare function resolveReview(q: SqlTx, id: string): Promise<boolean>;
/**
 * The outbox's own worker route (since v0.9.0): the hourly backstop for sends that failed right after the payment.
 * On a free-tier database keep it hourly (README "Free-tier databases"): `export const { GET } = createOutboxRoute({ cronSecret, drain: () => drainOutbox(…) })`.
 * Refuses (401) without `Authorization: Bearer <cronSecret>`, and always when `cronSecret` is unset. Answers the
 * drain's result, or 500 with the error's name only (a driver message may hold a secret). Bound it with the
 * drain's `limit` and `budgetMs`, below the route's own time limit.
 */
declare function createOutboxRoute(opts: {
    cronSecret: string | undefined;
    drain: () => Promise<{
        sent: number;
        failed: number;
        gaveUp: number;
        lost: number;
    }>;
}): {
    GET: (req: Request) => Promise<Response>;
};

export { createFulfilment, createOutboxRoute, drainOutbox, enqueue, fulfilmentState, importFulfilment, outboxCheck, resolveReview, reviewsCheck };
export type { DrainOptions, Fulfilment, FulfilmentActions, FulfilmentCause, FulfilmentOptions, FulfilmentReview, FulfilmentStateName, OutboxHandlers, SqlDb, SqlTx };
