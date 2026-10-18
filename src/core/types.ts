export type ReasonCode =
  | 'missing_body'
  | 'bad_signature_header'
  | 'signature_mismatch'
  | 'stale_timestamp'
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
   * An adjustment of a transaction this app never saw as its own (`ctx.known === false`): `processed`, the hook ran, no
   * warn line. It may be another app's refund on a shared seller account, so it does not count in `Health.lastOwnedAt`.
   */
  | 'unmatched';

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
export type Owns = OwnedIds | OwnsPredicate;

/** A transaction this app has seen, and whether it was this app's. */
export interface SeenTransaction {
  transactionId: string;
  owned: boolean;
}

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
   * When the last event this app treated as its own arrived (processed or stale). `null` if none yet. With
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
}
export type Logger = (entry: LogEntry) => void;
