import { decideAccess } from './access';
import { createWebhookHandler } from './handler';
import type { Health, Logger, ReasonCode, Store, Subscription } from './types';

export interface BillingConfig {
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

export interface Billing {
  config: Readonly<BillingConfig>;
  store: Store;
  log: Logger;
  handleWebhook(req: Request): Promise<Response>;
  handleHealth(req: Request): Promise<Response>;
  hasAccess(userId: string, feature: string): Promise<boolean>;
  getSubscriptions(userId: string): Promise<Subscription[]>;
  health(): Promise<Health>;
  recordFailure(reason: ReasonCode): Promise<void>;
}

const defaultLog: Logger = (entry) => console[entry.level](JSON.stringify({ source: 'paddle-kit', ...entry }));

export function createBilling(config: BillingConfig): Billing {
  if (!config.webhookSecret) throw new Error('paddle-kit: webhookSecret is required');
  const nodeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NODE_ENV;
  if (config.environment === 'production' && nodeEnv !== undefined && nodeEnv !== 'production' && !config.allowProductionInDev) {
    throw new Error('paddle-kit: environment "production" outside NODE_ENV=production; pass allowProductionInDev: true if intended');
  }
  const now = config.now ?? (() => new Date());
  const log = config.log ?? defaultLog;
  const policy = { entitlements: config.entitlements, pastDueGraceDays: config.pastDueGraceDays ?? 7 };
  const handleWebhook = createWebhookHandler({
    store: config.store,
    secret: config.webhookSecret,
    toleranceSeconds: config.signatureToleranceSeconds ?? 5,
    log,
    now,
  });

  return {
    config,
    store: config.store,
    log,
    handleWebhook,
    async handleHealth(req) {
      if (!config.healthToken) return new Response(null, { status: 404 });
      if (req.headers.get('authorization') !== `Bearer ${config.healthToken}`) return new Response(null, { status: 401 });
      return Response.json(await config.store.health(now()));
    },
    async hasAccess(userId, feature) {
      if (!userId) return false;
      return decideAccess(await config.store.getSubscriptionsByUser(userId), feature, policy, now());
    },
    getSubscriptions: (userId) => config.store.getSubscriptionsByUser(userId),
    health: () => config.store.health(now()),
    async recordFailure(reason) {
      log({ level: 'warn', reason });
      try {
        await config.store.recordFailure(reason, now());
      } catch {
        log({ level: 'error', reason: 'store_error' });
      }
    },
  };
}
