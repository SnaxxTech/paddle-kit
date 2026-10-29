import { decideAccess } from './access';
import { createWebhookHandler, report, timedStore, unverifiedCounter, within } from './handler';
import { isOwnsResolver, ownershipPredicate } from './owns';
import { safeEqual } from './signature';
import { version as kitVersion } from '../../package.json';
import type { Adjustment, AdjustmentContext, CheckResult, ErrorContext, HealthReport, HookContext, Logger, Owns, Store, Transaction } from './types';

export interface BillingConfig {
  environment: 'sandbox' | 'production';
  /**
   * The notification destination's secret. Several (an array) during a rotation: a request signed with any of them is
   * verified. Rotate by adding the new destination's secret, deploying, then removing the old one (README, Monitoring).
   */
  webhookSecret: string | readonly string[] | undefined;
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
   * Runs AT LEAST ONCE per verified `transaction.completed` event, and may run more than once (not `transaction.paid`, which is record-only): a retry after a failure or a timeout, or a delivery that takes over a crashed attempt's claim, runs it again.
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
   * Runs AT LEAST ONCE per verified `adjustment.created` / `adjustment.updated` event, and may run more than once (a retry after a failure or a timeout, or a delivery that takes over a crashed attempt's claim).
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
   * Since v0.7.0 also `{ resolve }` (what `readBillingEnv` returns with `resolvePrices`): the ids are awaited per event, and
   * a failed lookup answers 503 `prices_unavailable` instead of marking anything `not_ours`.
   */
  owns?: Owns;
  /**
   * Largest webhook body read, in bytes; a bigger one gets 413 `body_too_large` and is not read past the cap.
   * Default 4 MB (`MAX_WEBHOOK_BODY_BYTES`), just under Vercel's request limit. Paddle events are a few KB plus ~2 KB per
   * line item: lower it only if your largest transaction is far below the new value, or Paddle retries it and then drops it.
   */
  maxBodyBytes?: number;
  /**
   * How far in the future a signature's timestamp may be, in seconds (a server clock behind Paddle's). Default 60. A later
   * one is refused 401 `future_timestamp`. The past side stays fixed at 5 s (`stale_timestamp`).
   */
  clockSkewSeconds?: number;
  /**
   * Gets the original error when a hook, `owns`, the price lookup, the store or an app health check fails, so the app can
   * log why (the kit logs only the reason code: an error may carry secrets). Called after the failure is decided; what it
   * does or throws never changes the answer. Not called for refused requests (bad signature, no body): those are bots.
   */
  onError?: (error: unknown, ctx: ErrorContext) => void;
  /**
   * A hook (or an `owns` predicate or resolver) that takes longer fails the event as `hook_error` (500, Paddle retries).
   * The hook is not cancelled: it may still finish, and the retry runs it again (at least once). Unset: no limit.
   * Keep it below Paddle's own wait and well below `eventLeaseSeconds`.
   */
  hookTimeoutMs?: number;
  /** Each store call the kit makes (webhook, health, `hasAccess`) that takes longer fails as `store_error`. Unset: no limit. */
  storeTimeoutMs?: number;
  /**
   * App-defined checks, run on the authenticated health route (in parallel) and shown under `checks` by name. A check
   * that throws or takes longer than `healthCheckTimeoutMs` is `{ ok: false }`. `detail` is shown as is: no secrets.
   */
  healthChecks?: Record<string, () => Promise<CheckResult> | CheckResult>;
  /** Default 3000. */
  healthCheckTimeoutMs?: number;
  log?: Logger;
  now?: () => Date;
}

export interface Billing {
  config: Readonly<Omit<BillingConfig, 'webhookSecret'>>;
  /** The store itself: `billing.store.health(now)`, `billing.store.getSubscriptionsByUser(userId)`. */
  store: Store;
  handleWebhook(req: Request): Promise<Response>;
  handleHealth(req: Request): Promise<Response>;
  hasAccess(userId: string, feature: string): Promise<boolean>;
}

const defaultLog: Logger = (entry) => console[entry.level](JSON.stringify({ source: 'paddle-kit', ...entry }));

export function createBilling(config: BillingConfig): Billing {
  const secrets = typeof config.webhookSecret === 'string' ? [config.webhookSecret] : [...(config.webhookSecret ?? [])];
  if (secrets.length === 0 || secrets.some((s) => typeof s !== 'string' || !s)) throw new Error('paddle-kit: webhookSecret is required');
  const nodeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NODE_ENV;
  if (config.environment === 'production' && nodeEnv !== undefined && nodeEnv !== 'production' && !config.allowProductionInDev) {
    throw new Error('paddle-kit: environment "production" outside NODE_ENV=production; pass allowProductionInDev: true if intended');
  }
  const now = config.now ?? (() => new Date());
  const log = config.log ?? defaultLog;
  const policy = { entitlements: config.entitlements, pastDueGraceDays: config.pastDueGraceDays ?? 7 };
  const owns = isOwnsResolver(config.owns) ? config.owns : ownershipPredicate(config.owns);
  const store = timedStore(config.store, config.storeTimeoutMs);
  const unverified = unverifiedCounter(log, now);
  const handleWebhook = createWebhookHandler({
    owns,
    store,
    secret: secrets,
    toleranceSeconds: 5,
    futureSkewSeconds: config.clockSkewSeconds ?? 60,
    leaseSeconds: config.eventLeaseSeconds,
    log,
    now,
    onTransaction: config.onTransaction,
    onAdjustment: config.onAdjustment,
    maxBodyBytes: config.maxBodyBytes,
    onError: config.onError,
    hookTimeoutMs: config.hookTimeoutMs,
    unverified,
  });

  async function runCheck(name: string, check: () => Promise<CheckResult> | CheckResult): Promise<CheckResult> {
    const ms = config.healthCheckTimeoutMs ?? 3000;
    try {
      const result = await within(Promise.resolve().then(check), ms, `health check ${name}`);
      if (typeof result?.ok !== 'boolean') return { ok: false, detail: 'returned no { ok } result' };
      return typeof result.detail === 'string' ? { ok: result.ok, detail: result.detail } : { ok: result.ok };
    } catch (error) {
      report(config.onError, error, { reason: 'health_check', check: name });
      return { ok: false, detail: (error as Error)?.name === 'TimeoutError' ? `no answer in ${ms} ms` : 'threw an error' };
    }
  }

  const { webhookSecret: _omitted, ...publicConfig } = config;
  return {
    config: publicConfig,
    store: config.store,
    handleWebhook,
    async handleHealth(req) {
      if (!config.healthToken) return new Response(null, { status: 404 });
      if (!(await safeEqual(req.headers.get('authorization') ?? '', `Bearer ${config.healthToken}`))) return new Response(null, { status: 401 });
      const checks = config.healthChecks
        ? Promise.all(Object.entries(config.healthChecks).map(async ([name, check]) => [name, await runCheck(name, check)] as const))
        : null;
      try {
        const body: HealthReport = { ...(await store.health(now())), kitVersion, environment: config.environment, unverified: unverified.stats() };
        if (checks) body.checks = Object.fromEntries(await checks);
        return Response.json(body);
      } catch (error) {
        log({ level: 'error', reason: 'store_error' });
        report(config.onError, error, { reason: 'store_error' });
        return Response.json({ error: 'store_error' }, { status: 503 });
      }
    },
    async hasAccess(userId, feature) {
      if (!userId) return false;
      return decideAccess(await store.getSubscriptionsByUser(userId), feature, policy, now());
    },
  };
}
