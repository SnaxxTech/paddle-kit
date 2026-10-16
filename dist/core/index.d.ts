import { R as ReasonCode, S as Subscription, L as LineItem } from '../types-CqHfl8xh.js';
export { A as Adjustment, C as Customer, E as EventStatus, H as Health, a as HookContext, b as LogEntry, c as Logger, d as ScheduledChange, e as Store, f as SubscriptionStatus, T as Transaction } from '../types-CqHfl8xh.js';
export { B as Billing, a as BillingConfig, c as createBilling } from '../billing-5Tle0Jiz.js';

type VerifyResult = {
    ok: true;
} | {
    ok: false;
    reason: Extract<ReasonCode, 'bad_signature_header' | 'signature_mismatch' | 'stale_timestamp'>;
};
declare function verifySignature(input: {
    rawBody: string;
    header: string | null;
    secret: string;
    toleranceSeconds?: number;
    now?: number;
}): Promise<VerifyResult>;

interface AccessPolicy {
    entitlements: Record<string, readonly string[]>;
    pastDueGraceDays: number;
}
declare function decideAccess(subs: Subscription[], feature: string, policy: AccessPolicy, now: Date): boolean;

/** Line items (price, product, quantity) of a stored subscription, read from its raw Paddle payload. */
declare function itemsOf(sub: Subscription): LineItem[];
/** The full custom_data object of a stored subscription (not just userId), or null. */
declare function customDataOf(sub: Subscription): Record<string, unknown> | null;

export { type AccessPolicy, LineItem, ReasonCode, Subscription, type VerifyResult, customDataOf, decideAccess, itemsOf, verifySignature };
