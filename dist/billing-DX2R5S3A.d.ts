import { h as Store, T as Transaction, b as HookContext, A as Adjustment, a as AdjustmentContext, e as Owns, d as Logger } from './types-BxRTIlXY.js';

interface BillingConfig {
    environment: 'sandbox' | 'production';
    webhookSecret: string | undefined;
    store: Store;
    entitlements: Record<string, readonly string[]>;
    pastDueGraceDays?: number;
    healthToken?: string;
    allowProductionInDev?: boolean;
    /**
     * While one delivery of an event runs its hooks, duplicate deliveries of the same event answer 409 `in_progress`
     * (Paddle retries them later) instead of running the hooks again. A claim older than this many seconds counts as a
     * crashed attempt and is taken over. Default 60; keep it well above your slowest hook.
     */
    eventLeaseSeconds?: number;
    /**
     * Runs at least once per verified `transaction.completed` event (not `transaction.paid`, which is record-only) (a retry after a store failure, or concurrent duplicate deliveries, can run it again).
     * Make side effects idempotent: key on `tx.transactionId`. Keep hooks fast, Paddle waits ~5 s. Throwing fails the event
     * (HTTP 500, reason `hook_error`) so Paddle retries.
     * custom_data comes from the browser and is untrusted: verify the order by `tx.items` (priceId, quantity) — grant per quantity —
     * and record `tx.currency` (Paddle may localise it; don't require it to match your list currency). The catalog price fixes the amount.
     * Write the order and the grant in ONE database transaction so a failed grant rolls back and the retry re-grants. `subtotal` is before discount and tax (net of tax for tax-inclusive prices) and `total`
     * is the tax-inclusive grand total: don't equality-check either amount against a list price.
     * `transaction.completed` also fires for subscription renewals: one-time handlers filter `tx.subscriptionId === null`.
     */
    onTransaction?: (tx: Transaction, ctx: HookContext) => Promise<void> | void;
    /**
     * Runs at least once per verified `adjustment.created` / `adjustment.updated` event (a retry after a store failure, or concurrent duplicate deliveries, can run it again).
     * Make side effects idempotent: key on `adj.adjustmentId` + `adj.status`. Keep hooks fast, Paddle waits ~5 s. Throwing fails the event
     * (HTTP 500, reason `hook_error`) so Paddle retries.
     * Act on refunds (`adj.action === 'refund'`) only when `adj.status === 'approved'` (pending_approval and rejected adjustments also arrive).
     * Find your order by `adj.transactionId`; don't trust custom_data, it comes from the browser.
     * `ctx.known` is false when this app never saw the transaction as its own (the refund may have arrived before its
     * payment): record it so the payment path can refuse a taken-back payment; never drop it.
     */
    onAdjustment?: (adj: Adjustment, ctx: AdjustmentContext) => Promise<void> | void;
    /**
     * Shared seller account: the price and/or product ids this app sells (`readBillingEnv` returns them from
     * PADDLE_PRICES as `owns`), or a predicate over an event's line items and custom data. A subscription or transaction
     * with none of them is acknowledged and recorded as `ignored` / `not_ours`: never mirrored, no hook, not a failure.
     * A subscription already in the mirror stays ours. Adjustments of a transaction we saw as someone else's are
     * `not_ours` too; adjustments of a transaction never seen still reach `onAdjustment` with `ctx.known === false`.
     * Unset: every event is ours (a seller account of its own).
     */
    owns?: Owns;
    /**
     * Largest webhook body read, in bytes; a bigger one gets 413 `body_too_large` and is not read past the cap.
     * Default 4 MB (`MAX_WEBHOOK_BODY_BYTES`), just under Vercel's request limit. Paddle events are a few KB plus ~2 KB per
     * line item: lower it only if your largest transaction is far below the new value, or Paddle retries it and then drops it.
     */
    maxBodyBytes?: number;
    log?: Logger;
    now?: () => Date;
}
interface Billing {
    config: Readonly<Omit<BillingConfig, 'webhookSecret'>>;
    /** The store itself: `billing.store.health(now)`, `billing.store.getSubscriptionsByUser(userId)`. */
    store: Store;
    handleWebhook(req: Request): Promise<Response>;
    handleHealth(req: Request): Promise<Response>;
    hasAccess(userId: string, feature: string): Promise<boolean>;
}
declare function createBilling(config: BillingConfig): Billing;

export { type Billing as B, type BillingConfig as a, createBilling as c };
