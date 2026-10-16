import { decideAccess } from './access';
import { createWebhookHandler } from './handler';
import type { Adjustment, Health, HookContext, Logger, ReasonCode, Store, Subscription, Transaction } from './types';

export interface BillingConfig {
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

export interface Billing {
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
    onTransaction: config.onTransaction,
    onAdjustment: config.onAdjustment,
  });

  const { webhookSecret: _omitted, ...publicConfig } = config;
  return {
    config: publicConfig,
    store: config.store,
    log,
    handleWebhook,
    async handleHealth(req) {
      if (!config.healthToken) return new Response(null, { status: 404 });
      if (req.headers.get('authorization') !== `Bearer ${config.healthToken}`) return new Response(null, { status: 401 });
      try {
        return Response.json(await config.store.health(now()));
      } catch {
        log({ level: 'error', reason: 'store_error' });
        return Response.json({ error: 'store_error' }, { status: 503 });
      }
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
