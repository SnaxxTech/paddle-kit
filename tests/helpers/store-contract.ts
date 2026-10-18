import { beforeEach, describe, expect, it } from 'vitest';
import type { ReasonCode, Store, Subscription } from '../../src/core/types';

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

    it('returns a user\'s subscriptions newest lastEventAt first', async () => {
      await store.upsertSubscription(sub({ subscriptionId: 'sub_old', lastEventAt: '2026-10-01T00:00:00.000Z' }));
      await store.upsertSubscription(sub({ subscriptionId: 'sub_new', lastEventAt: '2026-10-12T00:00:00.000Z' }));
      await store.upsertSubscription(sub({ subscriptionId: 'sub_mid', lastEventAt: '2026-10-06T00:00:00.000Z' }));
      expect((await store.getSubscriptionsByUser('user_1')).map((x) => x.subscriptionId)).toEqual(['sub_new', 'sub_mid', 'sub_old']);
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
      expect(await store.health(now)).toEqual({ lastEventAt: null, lastFailureAt: null, lastFailureReason: null, failedLast24h: 0, unlinkedLast24h: 0, lastOwnedAt: null, notOursLast24h: 0 });

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
        lastOwnedAt: '2026-10-15T10:30:00.000Z',
        notOursLast24h: 0,
      });
    });

    it('reports lastOwnedAt (last processed event that owns matched: reason null or no_user_id) and notOursLast24h', async () => {
      const now = new Date('2026-10-15T12:00:00.000Z');
      const mark = async (id: string, at: string, status: 'processed' | 'ignored' | 'stale', reason: ReasonCode | null, eventType = 'subscription.updated') => {
        await store.recordEvent({ ...ev(id, at), eventType });
        await store.markEvent(id, status, reason);
      };
      await mark('evt_owned', '2026-10-14T08:00:00.000Z', 'processed', null, 'transaction.completed');
      await mark('evt_unlinked', '2026-10-14T09:00:00.000Z', 'processed', 'no_user_id'); // owns matched, no userId
      await mark('evt_late', '2026-10-15T09:30:00.000Z', 'stale', 'out_of_order'); // a late delivery proves nothing new
      await mark('evt_other_app_1', '2026-10-15T10:00:00.000Z', 'ignored', 'not_ours');
      await mark('evt_other_app_2', '2026-10-15T11:00:00.000Z', 'ignored', 'not_ours');
      await mark('evt_other_app_old', '2026-10-13T11:00:00.000Z', 'ignored', 'not_ours');
      await mark('evt_payout', '2026-10-15T11:30:00.000Z', 'ignored', 'unknown_event', 'payout.paid');
      await mark('evt_mirrored', '2026-10-15T11:40:00.000Z', 'processed', 'mirrored'); // kept only because already mirrored
      await store.recordEvent(ev('evt_running', '2026-10-15T11:45:00.000Z')); // received, not finished
      await mark('evt_refund_unseen_tx', '2026-10-15T11:50:00.000Z', 'processed', 'unmatched', 'adjustment.created');
      await mark('evt_customer', '2026-10-15T11:55:00.000Z', 'processed', 'unmatched', 'customer.created');
      expect(await store.health(now)).toMatchObject({
        lastEventAt: '2026-10-15T11:55:00.000Z',
        lastOwnedAt: '2026-10-14T09:00:00.000Z',
        notOursLast24h: 2,
      });
    });

    it('surfaces a hook_error failed event in health and reprocesses it', async () => {
      const now = new Date('2026-10-15T12:00:00.000Z');
      await store.recordEvent(ev('evt_hook', '2026-10-15T11:00:00.000Z'));
      await store.markEvent('evt_hook', 'failed', 'hook_error');
      expect(await store.health(now)).toMatchObject({ lastFailureAt: '2026-10-15T11:00:00.000Z', lastFailureReason: 'hook_error', failedLast24h: 1 });
      expect(await store.recordEvent(ev('evt_hook', '2026-10-15T11:00:00.000Z'))).toEqual({ alreadyDone: false });
    });

    it('counts a failure hit only inside the (now-24h, now] window', async () => {
      const now = new Date('2026-10-15T12:00:00.000Z');
      const cases: [string, string, number][] = [
        ['exactly now-24h', '2026-10-14T12:00:00.000Z', 0],
        ['exactly now', '2026-10-15T12:00:00.000Z', 1],
        ['1 minute in the future', '2026-10-15T12:01:00.000Z', 0],
      ];
      for (const [label, at, expected] of cases) {
        const fresh = await makeStore();
        await fresh.recordFailure('signature_mismatch', new Date(at));
        expect((await fresh.health(now)).failedLast24h, `recordFailure at ${label}`).toBe(expected);
      }
    });

    it('counts a failed event only inside the (now-24h, now] window', async () => {
      const now = new Date('2026-10-15T12:00:00.000Z');
      const cases: [string, string, number][] = [
        ['exactly now-24h', '2026-10-14T12:00:00.000Z', 0],
        ['exactly now', '2026-10-15T12:00:00.000Z', 1],
        ['1 minute in the future', '2026-10-15T12:01:00.000Z', 0],
      ];
      for (const [label, receivedAt, expected] of cases) {
        const fresh = await makeStore();
        await fresh.recordEvent(ev('evt_w', receivedAt));
        await fresh.markEvent('evt_w', 'failed', 'store_error');
        expect((await fresh.health(now)).failedLast24h, `failed event received at ${label}`).toBe(expected);
      }
    });

    it('takes lastFailure from a failed event received after every recordFailure hit', async () => {
      await store.recordFailure('signature_mismatch', new Date('2026-10-15T11:00:00.000Z'));
      await store.recordFailure('stale_timestamp', new Date('2026-10-15T11:10:00.000Z'));
      await store.recordEvent(ev('evt_late_fail', '2026-10-15T11:30:00.000Z'));
      await store.markEvent('evt_late_fail', 'failed', 'store_error');
      const h = await store.health(new Date('2026-10-15T12:00:00.000Z'));
      expect(h.lastFailureAt).toBe('2026-10-15T11:30:00.000Z');
      expect(h.lastFailureReason).toBe('store_error');
      expect(h.failedLast24h).toBe(3);
    });

    it('recordEvent on an existing id never changes the stored status or receivedAt', async () => {
      const now = new Date('2026-10-15T12:00:00.000Z');
      await store.recordEvent(ev('evt_f2'));
      await store.markEvent('evt_f2', 'failed', 'store_error');
      expect(await store.recordEvent(ev('evt_f2'))).toEqual({ alreadyDone: false });
      const failed = await store.health(now);
      expect(failed.failedLast24h).toBe(1);
      expect(failed.lastFailureReason).toBe('store_error');

      await store.recordEvent(ev('evt_p', '2026-10-15T10:00:00.000Z'));
      await store.markEvent('evt_p', 'processed', null);
      const before = await store.health(now);
      expect(await store.recordEvent(ev('evt_p', '2026-10-15T11:00:00.000Z'))).toEqual({ alreadyDone: true });
      expect((await store.health(now)).lastEventAt).toBe(before.lastEventAt);
      expect(before.lastEventAt).toBe('2026-10-15T10:00:00.000Z');
    });

    it('a live claim blocks a second claimer until markEvent releases it', async () => {
      const lease = '2026-10-15T09:59:00.000Z';
      expect(await store.recordEvent({ ...ev('evt_c'), leaseExpiredBefore: lease })).toEqual({ alreadyDone: false });
      expect(await store.recordEvent({ ...ev('evt_c'), leaseExpiredBefore: lease })).toEqual({ alreadyDone: false, inProgress: true });
      await store.markEvent('evt_c', 'failed', 'hook_error');
      // a failed attempt releases its claim: the retry runs at once, and the row still counts as failed meanwhile
      expect(await store.recordEvent({ ...ev('evt_c'), leaseExpiredBefore: lease })).toEqual({ alreadyDone: false });
      expect((await store.health(new Date('2026-10-15T12:00:00.000Z'))).failedLast24h).toBe(1);
      expect(await store.recordEvent({ ...ev('evt_c'), leaseExpiredBefore: lease })).toEqual({ alreadyDone: false, inProgress: true });
      await store.markEvent('evt_c', 'processed', null);
      expect(await store.recordEvent({ ...ev('evt_c'), leaseExpiredBefore: lease })).toEqual({ alreadyDone: true });
    });

    it('records seen transactions with their ownership; owned wins over not-owned', async () => {
      const t = { transactionId: 'txn_1', subscriptionId: null, customerId: 'ctm_1', occurredAt: '2026-10-15T09:00:00.000Z', receivedAt: '2026-10-15T09:00:01.000Z' };
      expect(await store.getTransaction!('txn_1')).toBeNull();
      await store.recordTransaction!({ ...t, owned: false });
      expect(await store.getTransaction!('txn_1')).toEqual({ transactionId: 'txn_1', owned: false });
      await store.recordTransaction!({ ...t, owned: true });
      await store.recordTransaction!({ ...t, owned: false }); // a later not-owned reading never un-owns it
      expect(await store.getTransaction!('txn_1')).toEqual({ transactionId: 'txn_1', owned: true });
      await store.recordTransaction!({ ...t, transactionId: 'txn_2', subscriptionId: 'sub_1', owned: true });
      expect(await store.getTransaction!('txn_2')).toEqual({ transactionId: 'txn_2', owned: true });
    });

    it('a claim older than the lease is taken over', async () => {
      expect(await store.recordEvent({ ...ev('evt_x', '2026-10-15T10:00:00.000Z'), leaseExpiredBefore: '2026-10-15T09:59:00.000Z' })).toEqual({ alreadyDone: false });
      expect(await store.recordEvent({ ...ev('evt_x', '2026-10-15T10:00:30.000Z'), leaseExpiredBefore: '2026-10-15T09:59:30.000Z' })).toEqual({ alreadyDone: false, inProgress: true });
      expect(await store.recordEvent({ ...ev('evt_x', '2026-10-15T10:01:01.000Z'), leaseExpiredBefore: '2026-10-15T10:00:01.000Z' })).toEqual({ alreadyDone: false });
      // the takeover is itself a live claim
      expect(await store.recordEvent({ ...ev('evt_x', '2026-10-15T10:01:02.000Z'), leaseExpiredBefore: '2026-10-15T10:00:02.000Z' })).toEqual({ alreadyDone: false, inProgress: true });
    });

    it('does not count an unlinked event received two days ago', async () => {
      await store.recordEvent(ev('evt_old_unlinked', '2026-10-13T12:00:00.000Z'));
      await store.markEvent('evt_old_unlinked', 'processed', 'no_user_id');
      expect((await store.health(new Date('2026-10-15T12:00:00.000Z'))).unlinkedLast24h).toBe(0);
    });

    it('a rejected stale upsert does not backfill a stored null userId', async () => {
      await store.upsertSubscription(sub({ userId: null, lastEventAt: '2026-10-10T00:00:00.000Z' }));
      expect(await store.upsertSubscription(sub({ userId: 'user_x', lastEventAt: '2026-10-09T00:00:00.000Z' }))).toEqual({ applied: false });
      expect((await store.getSubscription('sub_1'))?.userId).toBeNull();
    });

    it('a newer upsert with a different userId replaces the stored one', async () => {
      await store.upsertSubscription(sub({ userId: 'user_1', lastEventAt: '2026-10-10T00:00:00.000Z' }));
      expect(await store.upsertSubscription(sub({ userId: 'user_2', lastEventAt: '2026-10-11T00:00:00.000Z' }))).toEqual({ applied: true });
      expect((await store.getSubscription('sub_1'))?.userId).toBe('user_2');
    });

    it('applies a customer with an equal lastEventAt', async () => {
      await store.upsertCustomer({ customerId: 'ctm_1', email: 'a@x.com', lastEventAt: '2026-10-10T00:00:00.000Z' });
      expect(await store.upsertCustomer({ customerId: 'ctm_1', email: 'b@x.com', lastEventAt: '2026-10-10T00:00:00.000Z' })).toEqual({ applied: true });
    });

    it('compares lastEventAt as instants across timestamp formats', async () => {
      await store.upsertSubscription(sub({ status: 'active', lastEventAt: '2026-10-10T00:00:00.000Z' }));
      // String-greater but instant 2026-10-09T23:30Z, which is older: must be rejected.
      expect(await store.upsertSubscription(sub({ status: 'canceled', lastEventAt: '2026-10-10T00:30:00+01:00' }))).toEqual({ applied: false });
      expect((await store.getSubscription('sub_1'))?.status).toBe('active');
      // Same instant, different string: equal, so it applies.
      expect(await store.upsertSubscription(sub({ status: 'past_due', lastEventAt: '2026-10-10T00:00:00Z' }))).toEqual({ applied: true });
      expect((await store.getSubscription('sub_1'))?.status).toBe('past_due');
    });

    it('isolates stored subscriptions from mutation of inputs and outputs', async () => {
      const input = sub();
      await store.upsertSubscription(input);
      input.status = 'canceled';
      input.priceIds.push('pri_extra');
      const got = await store.getSubscription('sub_1');
      expect(got?.status).toBe('active');
      expect(got?.priceIds).toEqual(['pri_pro']);
      if (got) { got.status = 'canceled'; got.priceIds.push('pri_extra'); }
      const again = await store.getSubscription('sub_1');
      expect(again?.status).toBe('active');
      expect(again?.priceIds).toEqual(['pri_pro']);
    });

    it('re-upserting a read-back row with the same lastEventAt applies, despite sub-millisecond precision', async () => {
      await store.upsertSubscription(sub({ lastEventAt: '2026-10-10T00:00:00.621022Z' }));
      const back = await store.getSubscription('sub_1');
      expect(back).not.toBeNull();
      expect(await store.upsertSubscription({ ...back!, status: 'past_due' })).toEqual({ applied: true });
      expect((await store.getSubscription('sub_1'))?.status).toBe('past_due');
      // Same millisecond, different microseconds: equal at ms precision, so it applies.
      expect(await store.upsertSubscription(sub({ status: 'paused', lastEventAt: '2026-10-10T00:00:00.621999Z' }))).toEqual({ applied: true });
      expect((await store.getSubscription('sub_1'))?.status).toBe('paused');
    });

    it('reports store_error for a failed event marked with a null reason', async () => {
      await store.recordEvent(ev('evt_nr', '2026-10-15T11:00:00.000Z'));
      await store.markEvent('evt_nr', 'failed', null);
      expect((await store.health(new Date('2026-10-15T12:00:00.000Z'))).lastFailureReason).toBe('store_error');
    });
  });
}
