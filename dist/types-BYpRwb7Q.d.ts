type ReasonCode = 'missing_body' | 'missing_raw_body' | 'bad_signature_header' | 'signature_mismatch' | 'stale_timestamp' | 'bad_json' | 'bad_payload' | 'unknown_event' | 'no_user_id' | 'out_of_order' | 'store_error';
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

export type { Customer as C, EventStatus as E, Health as H, LogEntry as L, ReasonCode as R, Subscription as S, Logger as a, ScheduledChange as b, Store as c, SubscriptionStatus as d };
