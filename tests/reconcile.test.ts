import { describe, expect, it } from 'vitest';
import { createBilling } from '../src/core/billing';
import { memoryStore } from '../src/memory';
import { reconcile, type SdkSubscriptionLike } from '../src/reconcile';

const sdkSub = (o: Partial<SdkSubscriptionLike> = {}): SdkSubscriptionLike => ({
  id: 'sub_1', status: 'active', customerId: 'ctm_1', items: [{ price: { id: 'pri_pro' } }],
  currentBillingPeriod: { endsAt: '2026-11-01T00:00:00.000Z' }, scheduledChange: null,
  customData: { userId: 'user_1' }, canceledAt: null, updatedAt: '2026-10-14T00:00:00.000Z', ...o,
});
const client = (subs: SdkSubscriptionLike[]) => ({ subscriptions: { list: async function* () { yield* subs; } } });
const billing = () => createBilling({ environment: 'sandbox', webhookSecret: 's', store: memoryStore(), entitlements: { pri_pro: ['pro'] } });

describe('reconcile', () => {
  it('fills a missing subscription so access is correct after missed webhooks', async () => {
    const b = billing();
    expect(await reconcile(b, { apiKey: 'pdl_sdbx_apikey_x', client: client([sdkSub()]) })).toEqual({ scanned: 1, applied: 1, notOurs: 0 });
    expect(await b.hasAccess('user_1', 'pro')).toBe(true);
  });

  it('never overwrites newer webhook state with an older API snapshot', async () => {
    const b = billing();
    await b.store.upsertSubscription({
      subscriptionId: 'sub_1', customerId: 'ctm_1', userId: 'user_1', status: 'canceled', priceIds: ['pri_pro'],
      currentPeriodEnd: null, scheduledChange: null, canceledAt: '2026-10-15T00:00:00.000Z', pastDueSince: null,
      lastEventAt: '2026-10-15T00:00:00.000Z', raw: {},
    });
    expect(await reconcile(b, { apiKey: 'pdl_sdbx_apikey_x', client: client([sdkSub()]) })).toEqual({ scanned: 1, applied: 0, notOurs: 0 });
    expect(await b.hasAccess('user_1', 'pro')).toBe(false);
  });

  it('rejects a live key against a sandbox billing', async () => {
    await expect(reconcile(billing(), { apiKey: 'pdl_live_apikey_x', client: client([]) })).rejects.toThrow(/environment/);
  });
});
