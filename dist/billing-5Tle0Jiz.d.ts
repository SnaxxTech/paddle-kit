import { e as Store, T as Transaction, a as HookContext, A as Adjustment, c as Logger, S as Subscription, H as Health, R as ReasonCode } from './types-CqHfl8xh.js';

interface BillingConfig {
    environment: 'sandbox' | 'production';
    webhookSecret: string | undefined;
    store: Store;
    entitlements: Record<string, readonly string[]>;
    pastDueGraceDays?: number;
    signatureToleranceSeconds?: number;
    healthToken?: string;
    allowProductionInDev?: boolean;
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
     */
    onAdjustment?: (adj: Adjustment, ctx: HookContext) => Promise<void> | void;
    log?: Logger;
    now?: () => Date;
}
interface Billing {
    config: Readonly<Omit<BillingConfig, 'webhookSecret'>>;
    store: Store;
    log: Logger;
    handleWebhook(req: Request): Promise<Response>;
    handleHealth(req: Request): Promise<Response>;
    hasAccess(userId: string, feature: string): Promise<boolean>;
    getSubscriptions(userId: string): Promise<Subscription[]>;
    health(): Promise<Health>;
    recordFailure(reason: ReasonCode): Promise<void>;
}
declare function createBilling(config: BillingConfig): Billing;

export { type Billing as B, type BillingConfig as a, createBilling as c };
