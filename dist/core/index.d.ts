import { R as ReasonCode, S as Subscription } from '../types-BYpRwb7Q.js';
export { C as Customer, E as EventStatus, H as Health, L as LogEntry, a as Logger, b as ScheduledChange, c as Store, d as SubscriptionStatus } from '../types-BYpRwb7Q.js';
export { B as Billing, a as BillingConfig, c as createBilling } from '../billing-4EBe9L3i.js';

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

export { type AccessPolicy, ReasonCode, Subscription, type VerifyResult, decideAccess, verifySignature };
