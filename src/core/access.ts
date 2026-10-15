import type { Subscription, SubscriptionStatus } from './types';

export interface AccessPolicy {
  entitlements: Record<string, readonly string[]>;
  pastDueGraceDays: number;
}

const DAY_MS = 86_400_000;

export function grantsAccess(sub: Subscription, now: Date, graceDays: number): boolean {
  switch (sub.status) {
    case 'active':
    case 'trialing':
      return true;
    case 'past_due':
      if (!sub.pastDueSince) return true;
      return now.getTime() - Date.parse(sub.pastDueSince) <= graceDays * DAY_MS;
    default:
      return false;
  }
}

export function decideAccess(subs: Subscription[], feature: string, policy: AccessPolicy, now: Date): boolean {
  return subs.some(
    (s) => grantsAccess(s, now, policy.pastDueGraceDays) && s.priceIds.some((p) => policy.entitlements[p]?.includes(feature) ?? false),
  );
}

export function nextPastDueSince(prev: Subscription | null, status: SubscriptionStatus, occurredAt: string): string | null {
  if (status !== 'past_due') return null;
  if (prev?.status === 'past_due' && prev.pastDueSince) return prev.pastDueSince;
  return occurredAt;
}
