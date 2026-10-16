import { Environment, Paddle } from '@paddle/paddle-node-sdk';
import { nextPastDueSince } from '../core/access';
import type { Billing } from '../core/billing';
import { ownershipPredicate } from '../core/owns';
import type { Subscription } from '../core/types';

export interface SdkSubscriptionLike {
  id: string;
  status: string;
  customerId: string;
  items: Array<{ price?: { id?: string; productId?: string | null } | null; quantity?: number }>;
  currentBillingPeriod?: { endsAt?: string | null } | null;
  scheduledChange?: { action: string; effectiveAt: string } | null;
  customData?: Record<string, unknown> | null;
  canceledAt?: string | null;
  updatedAt: string;
}

export function fromSdkSubscription(s: SdkSubscriptionLike): Omit<Subscription, 'pastDueSince'> {
  const userId = s.customData?.userId;
  return {
    subscriptionId: s.id,
    customerId: s.customerId,
    userId: typeof userId === 'string' && userId ? userId : null,
    status: s.status as Subscription['status'],
    priceIds: s.items.map((i) => i.price?.id).filter((id): id is string => !!id),
    currentPeriodEnd: s.currentBillingPeriod?.endsAt ?? null,
    scheduledChange: s.scheduledChange ? { action: s.scheduledChange.action, effectiveAt: s.scheduledChange.effectiveAt } : null,
    canceledAt: s.canceledAt ?? null,
    // updatedAt, not "now": a webhook that occurred after this snapshot must still win.
    lastEventAt: s.updatedAt,
    raw: s,
  };
}

export async function reconcile(
  billing: Billing,
  opts: { apiKey: string; client?: { subscriptions: { list(): AsyncIterable<SdkSubscriptionLike> } } },
): Promise<{ scanned: number; applied: number; notOurs: number }> {
  const keyEnv = opts.apiKey.startsWith('pdl_sdbx_') ? 'sandbox' : opts.apiKey.startsWith('pdl_live_') ? 'production' : null;
  if (keyEnv !== billing.config.environment) {
    throw new Error(`paddle-kit: API key does not match environment "${billing.config.environment}"`);
  }
  const client =
    opts.client ??
    (new Paddle(opts.apiKey, {
      environment: billing.config.environment === 'production' ? Environment.production : Environment.sandbox,
    }) as unknown as { subscriptions: { list(): AsyncIterable<SdkSubscriptionLike> } });

  const owns = ownershipPredicate(billing.config.owns);
  let scanned = 0;
  let applied = 0;
  let notOurs = 0;
  for await (const raw of client.subscriptions.list()) {
    scanned++;
    const sub = fromSdkSubscription(raw);
    const prev = await billing.store.getSubscription(sub.subscriptionId);
    // A shared seller account lists every product's subscriptions: mirror only ours (or ones already mirrored).
    const items = raw.items.flatMap((i) => (i.price?.id ? [{ priceId: i.price.id, productId: i.price.productId ?? null, quantity: i.quantity ?? 1 }] : []));
    if (owns && !prev && !owns({ kind: 'subscription', items, customData: raw.customData ?? null })) {
      notOurs++;
      continue;
    }
    const result = await billing.store.upsertSubscription({ ...sub, pastDueSince: nextPastDueSince(prev, sub.status, sub.lastEventAt) });
    if (result.applied) applied++;
  }
  return { scanned, applied, notOurs };
}
