export type ReasonCode =
  | 'missing_body'
  /** The body is over the cap (`maxBodyBytes`, default 4 MB): answered 413 before the signature is checked. */
  | 'body_too_large'
  | 'bad_signature_header'
  | 'signature_mismatch'
  | 'stale_timestamp'
  /** The signature's timestamp is more than `clockSkewSeconds` (default 60) ahead of the server clock. Since v0.7.0. */
  | 'future_timestamp'
  | 'bad_json'
  | 'bad_payload'
  | 'unknown_event'
  | 'no_user_id'
  | 'out_of_order'
  | 'store_error'
  | 'hook_error'
  /** Shared seller account: the event belongs to another product (see `owns`). Recorded as `ignored`; not a failure. */
  | 'not_ours'
  /**
   * Processed, but `owns` never matched it: an adjustment of a transaction this app never saw (`ctx.known === false`,
   * maybe another app's refund). The hook ran; no warn line.
   */
  | 'unmatched'
  /**
   * Processed only because its subscription is already in the mirror; `owns` did not match it (a retired price, or a
   * subscription mirrored before `owns` was set). The hook ran; no warn line. Not counted in `Health.lastOwnedAt`.
   */
  | 'mirrored'
  /**
   * The app's price ids could not be found at run time (`owns` resolver threw: Paddle down, a wrong PADDLE_API_KEY, a
   * missing label). Answered 503 so Paddle retries; nothing is marked `not_ours`. Since v0.7.0.
   */
  | 'prices_unavailable';

export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'paused' | 'canceled';
export type EventStatus = 'received' | 'processed' | 'ignored' | 'stale' | 'failed';

export interface ScheduledChange {
  action: string;
  effectiveAt: string;
}

export interface Subscription {
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

export interface LineItem {
  priceId: string;
  productId: string | null;
  quantity: number;
}

export interface Transaction {
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

export interface Adjustment {
  adjustmentId: string;
  /** refund | credit | credit_reverse | chargeback | chargeback_reverse | chargeback_warning | chargeback_warning_reverse. `adjustmentEffect(adj)` says what each means. */
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

export interface HookContext {
  eventId: string;
  eventType: string;
  store: Store;
}

export interface AdjustmentContext extends HookContext {
  /**
   * true when this app has seen the adjusted transaction as its own (or the adjustment is on a subscription in its
   * mirror). false when it has not: the payment may not have arrived yet (a refund can arrive before its payment), it
   * predates paddle-kit v0.4.0, or the store cannot record transactions. Record a `known: false` refund so the payment
   * path can refuse it later; never drop it.
   */
  known: boolean;
}

/** The ids this app owns on a shared Paddle seller account. An event is ours when any line item matches. */
export interface OwnedIds {
  priceIds?: readonly string[];
  productIds?: readonly string[];
}
export type OwnsPredicate = (x: { kind: 'subscription' | 'transaction'; items: LineItem[]; customData: Record<string, unknown> | null }) => boolean;
/**
 * `owns` found at run time (`readBillingEnv` with `resolvePrices`, since v0.7.0): owned ids, or a predicate built from
 * them (an app that also matches its own custom data, e.g. `({ items, customData }) => …`). Awaited for each event
 * whose ownership it decides (subscription and transaction events, and adjustments of a mirrored subscription); a
 * throw (or no id) answers 503 `prices_unavailable`, so Paddle retries and no event is marked `not_ours` because a
 * lookup failed. Cache inside `resolve`: it runs once per such event.
 */
export interface OwnsResolver {
  resolve(): Promise<OwnedIds | OwnsPredicate>;
}
export type Owns = OwnedIds | OwnsPredicate | OwnsResolver;

/** A transaction this app has seen, and whether it was this app's. */
export interface SeenTransaction {
  transactionId: string;
  owned: boolean;
}

/** @deprecated since v0.5.0: the kit no longer writes customers. Kept until a release marked BREAKING removes it. */
export interface Customer {
  customerId: string;
  email: string | null;
  lastEventAt: string;
}

export interface Health {
  lastEventAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: ReasonCode | null;
  failedLast24h: number;
  unlinkedLast24h: number;
  /**
   * When the last event that `owns` matched arrived: a processed event with reason `null` or `no_user_id`. Not
   * `mirrored`, `unmatched` or stale (late) deliveries. Without `owns` every event matches. `null` if none yet. With
   * `notOursLast24h`, it shows a wrong `owns`: other products' events keep `lastEventAt` fresh while this one goes old.
   * Optional so custom stores keep compiling; the kit's stores always return it.
   */
  lastOwnedAt?: string | null;
  /** Events acked as `not_ours` in the last 24 hours. Normal on a shared seller account; alert only together with an old `lastOwnedAt`. */
  notOursLast24h?: number;
}

export interface Store {
  /**
   * Claims an event for processing. `alreadyDone`: a finished row exists (processed/ignored/stale). `inProgress`: another
   * attempt holds a live claim (`received` at or after `leaseExpiredBefore`), so this delivery must not run the hooks.
   * Otherwise the row is (re)claimed: inserted, or a `failed` / expired `received` row is set to `received` at `receivedAt`.
   * Without `leaseExpiredBefore` a `received` row is always reclaimable (the v0.3 behaviour).
   */
  recordEvent(e: { eventId: string; eventType: string; occurredAt: string; receivedAt: string; leaseExpiredBefore?: string }): Promise<{ alreadyDone: boolean; inProgress?: boolean }>;
  markEvent(eventId: string, status: EventStatus, reason: ReasonCode | null): Promise<void>;
  recordFailure(reason: ReasonCode, at: Date): Promise<void>;
  /**
   * @deprecated since v0.5.0: the kit no longer calls it (customer.* events are ignored). Still required, so custom
   * stores and the kit's three stores stay interchangeable; a release marked BREAKING will remove it. A no-op is fine.
   */
  upsertCustomer(c: Customer): Promise<{ applied: boolean }>;
  upsertSubscription(s: Subscription): Promise<{ applied: boolean }>;
  getSubscription(subscriptionId: string): Promise<Subscription | null>;
  getSubscriptionsByUser(userId: string): Promise<Subscription[]>;
  health(now: Date): Promise<Health>;
  /**
   * Remembers a seen transaction (needs migration 002). Once owned, always owned. Optional so custom stores keep
   * compiling; without it every adjustment reaches `onAdjustment` with `known: false`.
   */
  recordTransaction?(t: SeenTransaction & { subscriptionId: string | null; customerId: string | null; occurredAt: string; receivedAt: string }): Promise<void>;
  getTransaction?(transactionId: string): Promise<SeenTransaction | null>;
}

export interface LogEntry {
  level: 'warn' | 'error';
  reason: ReasonCode;
  eventId?: string;
  eventType?: string;
  /** Requests refused before the signature was verified since the previous such line (at most one line a minute). */
  count?: number;
}
export type Logger = (entry: LogEntry) => void;

/**
 * Requests refused before their signature was verified (no or oversized body, bad or missing signature, a timestamp out
 * of the window). Counted in this server instance's memory only, never in the store, so a bot hitting the URL cannot
 * keep a serverless database awake. Resets when the instance restarts; another instance has its own count.
 */
export interface UnverifiedStats {
  /** When this instance started counting. */
  since: string;
  count: number;
  byReason: Partial<Record<ReasonCode, number>>;
  lastAt: string | null;
  lastReason: ReasonCode | null;
}

/** What an app-defined health check returns. `detail` is shown as is: never put a secret in it. */
export interface CheckResult {
  ok: boolean;
  detail?: string;
}

/** The authenticated health route's JSON (`billing.handleHealth`). */
export interface HealthReport extends Health {
  kitVersion: string;
  environment: 'sandbox' | 'production';
  /** Since v0.7.0. */
  unverified: UnverifiedStats;
  /** Since v0.7.0, only when `createBilling({ healthChecks })` is set: each check by name. A timeout or a throw is `ok: false`. */
  checks?: Record<string, CheckResult>;
}

/** What `createBilling({ onError })` gets with the error. */
export interface ErrorContext {
  /** `hook_error`, `store_error` or `prices_unavailable` for a webhook or health failure; `health_check` for an app-defined check. */
  reason: ReasonCode | 'health_check';
  eventId?: string;
  eventType?: string;
  /** The check's name, for `health_check`. */
  check?: string;
}
