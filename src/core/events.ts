import type { Customer, Subscription, SubscriptionStatus } from './types';

export type SubscriptionInput = Omit<Subscription, 'pastDueSince'>;

interface Envelope {
  eventId: string;
  eventType: string;
  occurredAt: string;
}

export type NormalisedEvent =
  | (Envelope & { kind: 'subscription'; subscription: SubscriptionInput })
  | (Envelope & { kind: 'customer'; customer: Customer })
  | (Envelope & { kind: 'record-only' })
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
const RECORD_ONLY_EVENT_TYPES: ReadonlySet<string> = new Set(['transaction.completed']);
const STATUSES: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due', 'paused', 'canceled']);

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isTime = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
// eslint-disable-next-line no-control-regex
const hasControlChars = (v: string) => /[\u0000-\u001f\u007f-\u009f]/.test(v);
const optUserId = (v: unknown): string | null => (isStr(v) && !hasControlChars(v) ? v : null);
const optStr = (v: unknown): string | null => (isStr(v) ? v : null);

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
  if (RECORD_ONLY_EVENT_TYPES.has(env.eventType)) return { ...env, kind: 'record-only' };
  return { ...env, kind: 'ignored' };
}
