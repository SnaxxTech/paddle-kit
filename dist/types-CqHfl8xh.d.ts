type ReasonCode = 'missing_body' | 'missing_raw_body' | 'bad_signature_header' | 'signature_mismatch' | 'stale_timestamp' | 'bad_json' | 'bad_payload' | 'unknown_event' | 'no_user_id' | 'out_of_order' | 'store_error' | 'hook_error';
type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'paused' | 'canceled';
type EventStatus = 'received' | 'processed' | 'ignored' | 'stale' | 'failed';
interface ScheduledChange {
    action: string;
    effectiveAt: string;
}
interface Subscription {
    subscriptionId: string;
    customerId: string;
    userId: string | null;
    status: SubscriptionStatus;
    priceIds: string[];
    currentPeriodEnd: string | null;
    scheduledChange: ScheduledChange | null;
    canceledAt: string | null;
    pastDueSince: string | null;
    /** occurred_at of the event (or updated_at from reconcile) that produced this row. */
    lastEventAt: string;
    raw: unknown;
}
interface LineItem {
    priceId: string;
    productId: string | null;
    quantity: number;
}
interface Transaction {
    transactionId: string;
    status: string;
    customerId: string | null;
    subscriptionId: string | null;
    customData: Record<string, unknown> | null;
    items: LineItem[];
    currency: string | null;
    /** Grand total (tax-inclusive) in the currency's lowest unit, as Paddle sends it (a string). */
    total: string | null;
    /** Subtotal in the lowest unit (string): before discount and tax (net of tax for tax-inclusive prices). Don't equality-check it against a list price; verify by items (priceId, quantity) and record the currency rather than requiring it. */
    subtotal: string | null;
    occurredAt: string;
    raw: unknown;
}
interface Adjustment {
    adjustmentId: string;
    /** refund | credit | chargeback | chargeback_warning | … */
    action: string;
    /** `full` or `partial` (from Paddle's `type`); `null` when absent or not recognised. Only act on a `full` refund automatically. */
    type: 'full' | 'partial' | null;
    /** pending_approval | approved | rejected | reversed */
    status: string;
    transactionId: string;
    subscriptionId: string | null;
    customerId: string | null;
    currency: string | null;
    /** Adjusted amount (tax-inclusive) in the currency's lowest unit, as Paddle sends it (a string). */
    total: string | null;
    /** Adjusted amount before tax in the lowest unit (string). */
    subtotal: string | null;
    occurredAt: string;
    raw: unknown;
}
interface HookContext {
    eventId: string;
    eventType: string;
    store: Store;
}
interface Customer {
    customerId: string;
    email: string | null;
    lastEventAt: string;
}
interface Health {
    lastEventAt: string | null;
    lastFailureAt: string | null;
    lastFailureReason: ReasonCode | null;
    failedLast24h: number;
    unlinkedLast24h: number;
}
interface Store {
    recordEvent(e: {
        eventId: string;
        eventType: string;
        occurredAt: string;
        receivedAt: string;
    }): Promise<{
        alreadyDone: boolean;
    }>;
    markEvent(eventId: string, status: EventStatus, reason: ReasonCode | null): Promise<void>;
    recordFailure(reason: ReasonCode, at: Date): Promise<void>;
    upsertCustomer(c: Customer): Promise<{
        applied: boolean;
    }>;
    upsertSubscription(s: Subscription): Promise<{
        applied: boolean;
    }>;
    getSubscription(subscriptionId: string): Promise<Subscription | null>;
    getSubscriptionsByUser(userId: string): Promise<Subscription[]>;
    health(now: Date): Promise<Health>;
}
interface LogEntry {
    level: 'warn' | 'error';
    reason: ReasonCode;
    eventId?: string;
    eventType?: string;
}
type Logger = (entry: LogEntry) => void;

export type { Adjustment as A, Customer as C, EventStatus as E, Health as H, LineItem as L, ReasonCode as R, Subscription as S, Transaction as T, HookContext as a, LogEntry as b, Logger as c, ScheduledChange as d, Store as e, SubscriptionStatus as f };
