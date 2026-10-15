import { beforeEach, describe, expect, it } from 'vitest';
import type { Store, Subscription } from '../../src/core/types';

const sub = (o: Partial<Subscription> = {}): Subscription => ({
  subscriptionId: 'sub_1', customerId: 'ctm_1', userId: 'user_1', status: 'active', priceIds: ['pri_pro'],
  currentPeriodEnd: '2026-11-01T00:00:00.000Z', scheduledChange: null, canceledAt: null, pastDueSince: null,
  lastEventAt: '2026-10-10T00:00:00.000Z', raw: { id: 'sub_1' }, ...o,
});
const ev = (id: string, receivedAt = '2026-10-15T10:00:00.000Z') => ({
  eventId: id, eventType: 'subscription.updated', occurredAt: '2026-10-15T09:59:59.000Z', receivedAt,
});

export function runStoreContract(name: string, makeStore: () => Promise<Store>): void {
  describe(`Store contract: ${name}`, () => {
    let store: Store;
    beforeEach(async () => { store = await makeStore(); });

    it('dedupes finished events but reprocesses received/failed ones', async () => {
      expect(await store.recordEvent(ev('evt_1'))).toEqual({ alreadyDone: false });
      expect(await store.recordEvent(ev('evt_1'))).toEqual({ alreadyDone: false });
      await store.markEvent('evt_1', 'failed', 'store_error');
      expect(await store.recordEvent(ev('evt_1'))).toEqual({ alreadyDone: false });
      for (const status of ['processed', 'ignored', 'stale'] as const) {
        await store.markEvent('evt_1', status, null);
        expect(await store.recordEvent(ev('evt_1'))).toEqual({ alreadyDone: true });
      }
    });

    it('round-trips a subscription', async () => {
      const s = sub({ scheduledChange: { action: 'cancel', effectiveAt: '2026-11-01T00:00:00.000Z' }, priceIds: ['a', 'b'] });
      expect(await store.upsertSubscription(s)).toEqual({ applied: true });
      expect(await store.getSubscription('sub_1')).toEqual(s);
      expect(await store.getSubscriptionsByUser('user_1')).toEqual([s]);
      expect(await store.getSubscription('nope')).toBeNull();
    });

    it('applies newer-or-equal, rejects older', async () => {
      await store.upsertSubscription(sub({ status: 'active', lastEventAt: '2026-10-10T00:00:00.000Z' }));
      expect(await store.upsertSubscription(sub({ status: 'canceled', lastEventAt: '2026-10-09T00:00:00.000Z' }))).toEqual({ applied: false });
      expect((await store.getSubscription('sub_1'))?.status).toBe('active');
      expect(await store.upsertSubscription(sub({ status: 'past_due', lastEventAt: '2026-10-10T00:00:00.000Z' }))).toEqual({ applied: true });
      expect(await store.upsertSubscription(sub({ status: 'canceled', lastEventAt: '2026-10-11T00:00:00.000Z' }))).toEqual({ applied: true });
      expect((await store.getSubscription('sub_1'))?.status).toBe('canceled');
    });

    it('never erases a known userId with null', async () => {
      await store.upsertSubscription(sub({ userId: 'user_1' }));
      await store.upsertSubscription(sub({ userId: null, lastEventAt: '2026-10-12T00:00:00.000Z' }));
      expect((await store.getSubscription('sub_1'))?.userId).toBe('user_1');
    });

    it('applies customers with the same ordering rule', async () => {
      expect(await store.upsertCustomer({ customerId: 'ctm_1', email: 'a@x.com', lastEventAt: '2026-10-10T00:00:00.000Z' })).toEqual({ applied: true });
      expect(await store.upsertCustomer({ customerId: 'ctm_1', email: 'old@x.com', lastEventAt: '2026-10-09T00:00:00.000Z' })).toEqual({ applied: false });
    });

    it('reports health over a 24h window', async () => {
      const now = new Date('2026-10-15T12:00:00.000Z');
      expect(await store.health(now)).toEqual({ lastEventAt: null, lastFailureAt: null, lastFailureReason: null, failedLast24h: 0, unlinkedLast24h: 0 });

      await store.recordEvent(ev('evt_ok', '2026-10-15T10:00:00.000Z'));
      await store.markEvent('evt_ok', 'processed', null);
      await store.recordEvent(ev('evt_unlinked', '2026-10-15T10:30:00.000Z'));
      await store.markEvent('evt_unlinked', 'processed', 'no_user_id');
      await store.recordEvent(ev('evt_old_fail', '2026-10-13T10:00:00.000Z'));
      await store.markEvent('evt_old_fail', 'failed', 'store_error');
      await store.recordFailure('signature_mismatch', new Date('2026-10-15T11:00:00.000Z'));
      await store.recordFailure('signature_mismatch', new Date('2026-10-15T11:00:20.000Z'));

      expect(await store.health(now)).toEqual({
        lastEventAt: '2026-10-15T10:30:00.000Z',
        lastFailureAt: '2026-10-15T11:00:20.000Z',
        lastFailureReason: 'signature_mismatch',
        failedLast24h: 2,
        unlinkedLast24h: 1,
      });
    });
  });
}
