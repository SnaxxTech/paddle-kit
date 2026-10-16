import { B as Billing } from '../billing-5Tle0Jiz.js';
import { S as Subscription } from '../types-CqHfl8xh.js';

interface SdkSubscriptionLike {
    id: string;
    status: string;
    customerId: string;
    items: Array<{
        price?: {
            id?: string;
        } | null;
    }>;
    currentBillingPeriod?: {
        endsAt?: string | null;
    } | null;
    scheduledChange?: {
        action: string;
        effectiveAt: string;
    } | null;
    customData?: Record<string, unknown> | null;
    canceledAt?: string | null;
    updatedAt: string;
}
declare function fromSdkSubscription(s: SdkSubscriptionLike): Omit<Subscription, 'pastDueSince'>;
declare function reconcile(billing: Billing, opts: {
    apiKey: string;
    client?: {
        subscriptions: {
            list(): AsyncIterable<SdkSubscriptionLike>;
        };
    };
}): Promise<{
    scanned: number;
    applied: number;
}>;

export { type SdkSubscriptionLike, fromSdkSubscription, reconcile };
