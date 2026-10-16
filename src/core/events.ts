import type { Adjustment, Customer, LineItem, Subscription, SubscriptionStatus, Transaction } from './types';

export type SubscriptionInput = Omit<Subscription, 'pastDueSince'>;

interface Envelope {
  eventId: string;
  eventType: string;
  occurredAt: string;
}

export type NormalisedEvent =
  | (Envelope & { kind: 'subscription'; subscription: SubscriptionInput })
  | (Envelope & { kind: 'customer'; customer: Customer })
  | (Envelope & { kind: 'transaction'; transaction: Transaction })
  | (Envelope & { kind: 'adjustment'; adjustment: Adjustment })
  | (Envelope & { kind: 'ignored' });

export const SUBSCRIPTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'subscription.created',
  'subscription.imported',
  'subscription.updated',
  'subscription.activated',
  'subscription.trialing',
  'subscription.past_due',
  'subscription.paused',
  'subscription.resumed',
  'subscription.canceled',
]);
const CUSTOMER_EVENT_TYPES: ReadonlySet<string> = new Set(['customer.created', 'customer.updated']);
const TRANSACTION_EVENT_TYPES: ReadonlySet<string> = new Set(['transaction.completed', 'transaction.paid']);
const ADJUSTMENT_EVENT_TYPES: ReadonlySet<string> = new Set(['adjustment.created', 'adjustment.updated']);
const STATUSES: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due', 'paused', 'canceled']);

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isTime = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
// eslint-disable-next-line no-control-regex
const hasControlChars = (v: string) => /[\u0000-\u001f\u007f-\u009f]/.test(v);
const optUserId = (v: unknown): string | null => (isStr(v) && !hasControlChars(v) ? v : null);
const optStr = (v: unknown): string | null => (isStr(v) ? v : null);

function quantityOf(v: unknown): number {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 1;
}

function lineItemsOf(items: unknown): LineItem[] {
  if (!Array.isArray(items)) return [];
  const out: LineItem[] = [];
  for (const item of items) {
    if (!isObj(item)) continue;
    const price = isObj(item.price) ? item.price : null;
    const priceId = optStr(price?.id) ?? optStr(item.price_id);
    if (!priceId) continue;
    out.push({ priceId, productId: optStr(price?.product_id), quantity: quantityOf(item.quantity) });
  }
  return out;
}

const customDataFrom = (v: unknown): Record<string, unknown> | null => (isObj(v) ? v : null);

/** Line items (price, product, quantity) of a stored subscription, read from its raw Paddle payload. */
export function itemsOf(sub: Pick<Subscription, 'raw'>): LineItem[] {
  return isObj(sub.raw) ? lineItemsOf(sub.raw.items) : [];
}

/** The full custom_data object of a stored subscription (not just userId), or null. */
export function customDataOf(sub: Pick<Subscription, 'raw'>): Record<string, unknown> | null {
  return isObj(sub.raw) ? customDataFrom(sub.raw.custom_data) : null;
}

export function parseEvent(json: unknown): NormalisedEvent | null {
  if (!isObj(json) || !isStr(json.event_id) || !isStr(json.event_type) || !isTime(json.occurred_at) || !isObj(json.data)) {
    return null;
  }
  const env: Envelope = { eventId: json.event_id, eventType: json.event_type, occurredAt: json.occurred_at };
  const data = json.data;

  if (SUBSCRIPTION_EVENT_TYPES.has(env.eventType)) {
    if (!isStr(data.id) || !isStr(data.customer_id) || !STATUSES.has(data.status) || !Array.isArray(data.items)) return null;
    const priceIds = data.items.map((item: any) => item?.price?.id).filter(isStr);
    const sc = isObj(data.scheduled_change) && isStr(data.scheduled_change.action) && isTime(data.scheduled_change.effective_at)
      ? { action: data.scheduled_change.action, effectiveAt: data.scheduled_change.effective_at }
      : null;
    return {
      ...env,
      kind: 'subscription',
      subscription: {
        subscriptionId: data.id,
        customerId: data.customer_id,
        userId: isObj(data.custom_data) ? optUserId(data.custom_data.userId) : null,
        status: data.status as SubscriptionStatus,
        priceIds,
        currentPeriodEnd: isObj(data.current_billing_period) ? optStr(data.current_billing_period.ends_at) : null,
        scheduledChange: sc,
        canceledAt: optStr(data.canceled_at),
        lastEventAt: env.occurredAt,
        raw: data,
      },
    };
  }
  if (CUSTOMER_EVENT_TYPES.has(env.eventType)) {
    if (!isStr(data.id)) return null;
    return { ...env, kind: 'customer', customer: { customerId: data.id, email: optStr(data.email), lastEventAt: env.occurredAt } };
  }
  if (TRANSACTION_EVENT_TYPES.has(env.eventType)) {
    if (!isStr(data.id)) return null;
    const totals = isObj(data.details) && isObj(data.details.totals) ? data.details.totals : null;
    return {
      ...env,
      kind: 'transaction',
      transaction: {
        transactionId: data.id,
        status: optStr(data.status) ?? 'unknown',
        customerId: optStr(data.customer_id),
        subscriptionId: optStr(data.subscription_id),
        customData: customDataFrom(data.custom_data),
        items: lineItemsOf(data.items),
        currency: optStr(data.currency_code) ?? optStr(totals?.currency_code),
        total: optStr(totals?.grand_total) ?? optStr(totals?.total),
        subtotal: optStr(totals?.subtotal),
        occurredAt: env.occurredAt,
        raw: data,
      },
    };
  }
  if (ADJUSTMENT_EVENT_TYPES.has(env.eventType)) {
    if (!isStr(data.id) || !isStr(data.transaction_id)) return null;
    return {
      ...env,
      kind: 'adjustment',
      adjustment: {
        adjustmentId: data.id,
        action: optStr(data.action) ?? 'unknown',
        type: data.type === 'full' || data.type === 'partial' ? data.type : null,
        status: optStr(data.status) ?? 'unknown',
        transactionId: data.transaction_id,
        subscriptionId: optStr(data.subscription_id),
        customerId: optStr(data.customer_id),
        currency: optStr(data.currency_code) ?? (isObj(data.totals) ? optStr(data.totals.currency_code) : null),
        total: isObj(data.totals) ? optStr(data.totals.total) : null,
        subtotal: isObj(data.totals) ? optStr(data.totals.subtotal) : null,
        occurredAt: env.occurredAt,
        raw: data,
      },
    };
  }
  return { ...env, kind: 'ignored' };
}
