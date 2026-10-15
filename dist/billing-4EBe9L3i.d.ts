import { c as Store, a as Logger, S as Subscription, H as Health, R as ReasonCode } from './types-BYpRwb7Q.js';

interface BillingConfig {
    environment: 'sandbox' | 'production';
    webhookSecret: string | undefined;
    store: Store;
    entitlements: Record<string, readonly string[]>;
    pastDueGraceDays?: number;
    signatureToleranceSeconds?: number;
    healthToken?: string;
    allowProductionInDev?: boolean;
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
