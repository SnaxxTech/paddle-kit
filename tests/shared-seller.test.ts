import { PGlite } from '@electric-sql/pglite';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { createBilling, type BillingConfig } from '../src/core/billing';
import { memoryStore } from '../src/memory';
import { MIGRATIONS, postgresStore } from '../src/postgres';
import { SQLITE_MIGRATIONS, sqliteStore } from '../src/sqlite';
import { reconcile } from '../src/reconcile';
import type { Adjustment, AdjustmentContext, LogEntry, Store, Transaction } from '../src/core/types';
import { sign } from './helpers/sign';
import { loadFixture, subscriptionEvent } from './helpers/fixtures';

const SECRET = 'pdl_ntfset_test';
const NOW = new Date('2026-10-15T12:00:00Z');
const ts = Math.floor(NOW.getTime() / 1000);
// Prices and products in the real fixtures (subscription.created and transaction.completed share them).
const SEAT_PRICE = 'pri_01gsz8x8sawmvhz1pv30nge1ke';
const SEAT_PRODUCT = 'pro_01gsz4t5hdjse780zja8vvr7jg';
const OTHER_APP = { priceIds: ['pri_someone_else'] };

// The same scenario on all three kit stores.
async function threeStores(): Promise<Store[]> {
  const db = new PGlite();
  for (const m of MIGRATIONS) await db.exec(m.sql);
  const lite = new Database(':memory:');
  for (const m of SQLITE_MIGRATIONS) lite.exec(m.sql);
  return [memoryStore(), postgresStore({ query: (q, p) => db.query(q, p) as any }), sqliteStore({ db: lite })];
}

function setup(o: Partial<BillingConfig> = {}, store: Store = memoryStore()) {
  const txs: Transaction[] = [];
  const adjs: Array<{ adj: Adjustment; ctx: AdjustmentContext }> = [];
  const logs: LogEntry[] = [];
  const mark = vi.spyOn(store, 'markEvent');
  const billing = createBilling({
    environment: 'sandbox', webhookSecret: SECRET, store, entitlements: {}, now: () => NOW, log: (e) => logs.push(e),
    onTransaction: (tx) => { txs.push(tx); },
    onAdjustment: (adj, ctx) => { adjs.push({ adj, ctx }); },
    ...o,
  });
  const send = async (event: unknown) => {
    const body = JSON.stringify(event);
    return billing.handleWebhook(new Request('https://app.test/', { method: 'POST', headers: { 'paddle-signature': sign(body, SECRET, ts) }, body }));
  };
  const reasonOf = (eventId: string) => mark.mock.calls.filter((c) => c[0] === eventId).at(-1)?.slice(1);
  return { billing, store, send, txs, adjs, logs, reasonOf };
}

const txn = (o: { eventId?: string; eventType?: string; id?: string; occurredAt?: string } = {}) => {
  const base = loadFixture('transaction.completed');
  return {
    ...base, event_id: o.eventId ?? base.event_id, event_type: o.eventType ?? base.event_type, occurred_at: o.occurredAt ?? base.occurred_at,
    data: { ...base.data, id: o.id ?? base.data.id },
  };
};
const adjustment = (o: { eventId?: string; transactionId: string; subscriptionId?: string | null; status?: string }) => {
  const base = loadFixture('adjustment.created');
  return {
    ...base, event_id: o.eventId ?? base.event_id,
    data: { ...base.data, transaction_id: o.transactionId, subscription_id: o.subscriptionId ?? null, status: o.status ?? 'approved' },
  };
};

describe('shared seller account: owns', () => {
  it('a transaction with none of our prices is acknowledged, recorded as ignored/not_ours, and fires no hook', async () => {
    const t = setup({ owns: OTHER_APP });
    const res = await t.send(txn());
    expect(res.status).toBe(200);
    expect(t.txs).toHaveLength(0);
    expect(t.reasonOf(loadFixture('transaction.completed').event_id)).toEqual(['ignored', 'not_ours']);
    const health = await t.billing.store.health(NOW);
    expect(health.failedLast24h).toBe(0);
    expect(health.lastEventAt).toBe(NOW.toISOString()); // still proves the webhook is alive
    expect(t.logs).toEqual([]); // normal traffic on a shared account: no warn line
  });

  it('a misconfigured owns shows in health: notOursLast24h counts our own sale, lastOwnedAt stays null', async () => {
    for (const store of await threeStores()) {
      const t = setup({ owns: { priceIds: ['pri_typo'] } }, store);
      // another app's refund of a payment this app never saw: reaches onAdjustment, but is not proof that owns works
      expect((await t.send(adjustment({ eventId: 'evt_foreign_refund', transactionId: 'txn_other_app' }))).status).toBe(200);
      expect(t.adjs.map((a) => a.ctx.known)).toEqual([false]);
      expect(await store.health(NOW)).toMatchObject({ lastOwnedAt: null, notOursLast24h: 0 });
      expect(t.reasonOf('evt_foreign_refund')).toEqual(['processed', 'unmatched']);
      // customer.* has no line items, so owns never sees it: neither another app's customer nor our own counts
      const customer = loadFixture('customer.created');
      expect((await t.send({ ...customer, event_id: 'evt_foreign_customer', data: { ...customer.data, id: 'ctm_other_app' } })).status).toBe(200);
      expect((await t.send({ ...customer, event_id: 'evt_our_customer' })).status).toBe(200);
      expect(await store.health(NOW)).toMatchObject({ lastOwnedAt: null, notOursLast24h: 0 });
      expect((await t.send(txn())).status).toBe(200);
      expect(t.txs).toHaveLength(0);
      expect(await store.health(NOW)).toMatchObject({ lastEventAt: NOW.toISOString(), failedLast24h: 0, notOursLast24h: 1, lastOwnedAt: null });
      const fixed = setup({ owns: { priceIds: [SEAT_PRICE] } }, store);
      expect((await fixed.send(txn({ eventId: 'evt_next_sale', id: 'txn_next' }))).status).toBe(200);
      expect((await store.health(NOW)).lastOwnedAt).toBe(NOW.toISOString());
    }
  });

  it('owns breaks after a subscription is mirrored: its renewals are processed as mirrored and do not refresh lastOwnedAt', async () => {
    const DAY1 = new Date(NOW.getTime() - 19 * 86_400_000);
    const SUB = loadFixture('subscription.created').data.id;
    for (const store of await threeStores()) {
      const day1 = setup({ owns: { priceIds: [SEAT_PRICE] }, now: () => DAY1 }, store);
      expect((await day1.send(subscriptionEvent({ eventId: 'evt_d1_sub' }))).status).toBe(200);
      expect(day1.reasonOf('evt_d1_sub')).toEqual(['processed', null]);
      expect((await store.health(DAY1)).lastOwnedAt).toBe(DAY1.toISOString());

      const broken = setup({ owns: { priceIds: ['pri_typo'] } }, store); // day 20
      const update = subscriptionEvent({ eventId: 'evt_d20_sub', eventType: 'subscription.updated', occurredAt: '2026-10-16T00:00:00Z', data: { status: 'past_due' } });
      expect((await broken.send(update)).status).toBe(200);
      expect((await store.getSubscription(SUB))?.status).toBe('past_due'); // still mirrored, as before
      expect((await broken.send(txn({ eventId: 'evt_d20_renewal', id: 'txn_renewal_d20' }))).status).toBe(200);
      expect(broken.txs).toHaveLength(1); // the renewal on the mirrored subscription still runs the hook
      // a refund of that renewal: known (the subscription is mirrored), but owns does not match it either
      expect((await broken.send(adjustment({ eventId: 'evt_d20_refund', transactionId: 'txn_renewal_d20', subscriptionId: SUB }))).status).toBe(200);
      expect(broken.adjs.map((a) => a.ctx.known)).toEqual([true]);
      expect(broken.reasonOf('evt_d20_refund')).toEqual(['processed', 'mirrored']);
      const newSale = txn({ eventId: 'evt_d20_new_sale', id: 'txn_new_sale' });
      expect((await broken.send({ ...newSale, data: { ...newSale.data, subscription_id: null } })).status).toBe(200);
      expect(await store.health(NOW)).toMatchObject({ lastOwnedAt: DAY1.toISOString(), notOursLast24h: 1, failedLast24h: 0 });
      expect([broken.reasonOf('evt_d20_sub'), broken.reasonOf('evt_d20_renewal')]).toEqual([['processed', 'mirrored'], ['processed', 'mirrored']]);

      const fixed = setup({ owns: { priceIds: [SEAT_PRICE] } }, store);
      expect((await fixed.send(txn({ eventId: 'evt_d20_renewal_2', id: 'txn_renewal_2' }))).status).toBe(200);
      expect(fixed.reasonOf('evt_d20_renewal_2')).toEqual(['processed', null]);
      expect((await fixed.send(adjustment({ eventId: 'evt_d20_refund_2', transactionId: 'txn_renewal_2', subscriptionId: SUB }))).status).toBe(200);
      expect(fixed.reasonOf('evt_d20_refund_2')).toEqual(['processed', null]);
      expect((await store.health(NOW)).lastOwnedAt).toBe(NOW.toISOString());
    }
  });

  it('a foreign subscription mirrored before owns existed does not refresh lastOwnedAt once owns is set', async () => {
    const DAY1 = new Date(NOW.getTime() - 19 * 86_400_000);
    for (const store of await threeStores()) {
      const before = setup({ now: () => DAY1 }, store); // no owns yet: every event is ours, so the other app's subscription is mirrored
      expect((await before.send(subscriptionEvent({ eventId: 'evt_foreign_sub' }))).status).toBe(200);
      const after = setup({ owns: OTHER_APP }, store);
      expect((await after.send(subscriptionEvent({ eventId: 'evt_foreign_upd', eventType: 'subscription.updated', occurredAt: '2026-10-16T00:00:00Z' }))).status).toBe(200);
      expect((await after.send(txn({ eventId: 'evt_foreign_renewal', id: 'txn_foreign_renewal' }))).status).toBe(200);
      expect(await store.health(NOW)).toMatchObject({ lastOwnedAt: DAY1.toISOString() });
      expect(after.reasonOf('evt_foreign_upd')).toEqual(['processed', 'mirrored']);
    }
  });

  it('transaction.paid that is not ours is ignored/not_ours too', async () => {
    const t = setup({ owns: OTHER_APP });
    expect((await t.send(txn({ eventId: 'evt_paid', eventType: 'transaction.paid' }))).status).toBe(200);
    expect(t.reasonOf('evt_paid')).toEqual(['ignored', 'not_ours']);
  });

  it('owns by price id: our transaction fires onTransaction', async () => {
    const t = setup({ owns: { priceIds: [SEAT_PRICE] } });
    await t.send(txn());
    expect(t.txs).toHaveLength(1);
  });

  it('owns by product id: our transaction fires onTransaction', async () => {
    const t = setup({ owns: { productIds: [SEAT_PRODUCT] } });
    await t.send(txn());
    expect(t.txs).toHaveLength(1);
  });

  it('owns as a predicate receives the kind, line items and custom data', async () => {
    const seen: unknown[] = [];
    const t = setup({ owns: (x) => { seen.push(x.kind); return x.items.some((i) => i.priceId === SEAT_PRICE); } });
    await t.send(txn());
    expect(t.txs).toHaveLength(1);
    expect(seen).toEqual(['transaction']);
  });

  it('a subscription that is not ours is never mirrored and does not count as unlinked', async () => {
    const t = setup({ owns: OTHER_APP });
    const ev = subscriptionEvent({ eventId: 'evt_sub', data: { custom_data: null } });
    expect((await t.send(ev)).status).toBe(200);
    expect(await t.store.getSubscription(ev.data.id)).toBeNull();
    expect(t.reasonOf('evt_sub')).toEqual(['ignored', 'not_ours']);
    expect((await t.billing.store.health(NOW)).unlinkedLast24h).toBe(0);
  });

  it('our subscription is mirrored', async () => {
    const t = setup({ owns: { priceIds: [SEAT_PRICE] } });
    const ev = subscriptionEvent({ eventId: 'evt_sub' });
    await t.send(ev);
    expect((await t.store.getSubscription(ev.data.id))?.status).toBe('active');
  });

  it('a subscription already in the mirror stays ours when a later event carries none of our prices', async () => {
    const t = setup({ owns: { priceIds: [SEAT_PRICE] } });
    const created = subscriptionEvent({ eventId: 'evt_1', occurredAt: '2026-10-15T10:00:00Z' });
    await t.send(created);
    const moved = subscriptionEvent({
      eventId: 'evt_2', eventType: 'subscription.updated', occurredAt: '2026-10-15T11:00:00Z',
      data: { status: 'canceled', items: [{ price: { id: 'pri_unknown', product_id: 'pro_unknown' }, quantity: 1 }] },
    });
    await t.send(moved);
    expect((await t.store.getSubscription(created.data.id))?.status).toBe('canceled');
  });

  it('a throwing owns predicate fails the event as hook_error (Paddle retries), never store_error', async () => {
    const t = setup({ owns: () => { throw new Error('secret detail'); } });
    const res = await t.send(txn({ eventId: 'evt_throw' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'hook_error' });
    expect(t.reasonOf('evt_throw')).toEqual(['failed', 'hook_error']);
  });

  it('createBilling refuses an owns object with no ids (it would ignore every event)', () => {
    expect(() => setup({ owns: {} })).toThrow(/owns/);
    expect(() => setup({ owns: { priceIds: [], productIds: [] } })).toThrow(/owns/);
  });
});

describe('shared seller account: adjustments', () => {
  it('a refund for a transaction never seen reaches onAdjustment with known: false (a refund can arrive before its payment)', async () => {
    const t = setup({ owns: { priceIds: [SEAT_PRICE] } });
    const txId = loadFixture('transaction.completed').data.id;
    expect((await t.send(adjustment({ eventId: 'evt_adj', transactionId: txId }))).status).toBe(200);
    expect(t.adjs).toHaveLength(1);
    expect(t.adjs[0]!.ctx.known).toBe(false);
    expect(t.reasonOf('evt_adj')).toEqual(['processed', 'unmatched']);
    // the payment arrives afterwards and is still fulfilled
    await t.send(txn());
    expect(t.txs).toHaveLength(1);
  });

  it('a refund for one of our transactions is known: true', async () => {
    const t = setup({ owns: { priceIds: [SEAT_PRICE] } });
    await t.send(txn());
    await t.send(adjustment({ transactionId: loadFixture('transaction.completed').data.id }));
    expect(t.adjs.map((a) => a.ctx.known)).toEqual([true]);
  });

  it("a refund for a transaction we saw and know is someone else's is ignored/not_ours and fires no hook", async () => {
    const t = setup({ owns: OTHER_APP });
    await t.send(txn());
    const res = await t.send(adjustment({ eventId: 'evt_adj', transactionId: loadFixture('transaction.completed').data.id }));
    expect(res.status).toBe(200);
    expect(t.adjs).toHaveLength(0);
    expect(t.reasonOf('evt_adj')).toEqual(['ignored', 'not_ours']);
  });

  it('a refund on one of our mirrored subscriptions is known: true even when its transaction was never seen', async () => {
    const t = setup({ owns: { priceIds: [SEAT_PRICE] } });
    const sub = subscriptionEvent({ eventId: 'evt_sub' });
    await t.send(sub);
    await t.send(adjustment({ transactionId: 'txn_renewal_before_upgrade', subscriptionId: sub.data.id }));
    expect(t.adjs.map((a) => a.ctx.known)).toEqual([true]);
  });

  it('without owns every event is ours; known still says whether the transaction was seen', async () => {
    const t = setup();
    await t.send(adjustment({ eventId: 'evt_a1', transactionId: 'txn_never_seen' }));
    await t.send(txn());
    await t.send(adjustment({ eventId: 'evt_a2', transactionId: loadFixture('transaction.completed').data.id }));
    expect(t.adjs.map((a) => a.ctx.known)).toEqual([false, true]);
    expect(t.txs).toHaveLength(1);
  });

  it('a custom store without transaction methods: adjustments still reach the hook, known: false', async () => {
    const { recordTransaction: _r, getTransaction: _g, ...bare } = memoryStore();
    const t = setup({ owns: OTHER_APP }, bare as Store);
    await t.send(txn());
    await t.send(adjustment({ transactionId: loadFixture('transaction.completed').data.id }));
    expect(t.adjs.map((a) => a.ctx.known)).toEqual([false]);
  });

  it('the ledger reason lands in real Postgres (PGlite)', async () => {
    const db = new PGlite();
    for (const m of MIGRATIONS) await db.exec(m.sql);
    const t = setup({ owns: OTHER_APP }, postgresStore({ query: (q, p) => db.query(q, p) as any }));
    await t.send(txn({ eventId: 'evt_other' }));
    await t.send(adjustment({ eventId: 'evt_refund_other', transactionId: loadFixture('transaction.completed').data.id }));
    await t.send(adjustment({ eventId: 'evt_refund_unknown', transactionId: 'txn_unknown' }));
    const rows = (await db.query('SELECT event_id, status, reason FROM paddle_events ORDER BY event_id')).rows;
    expect(rows).toEqual([
      { event_id: 'evt_other', status: 'ignored', reason: 'not_ours' },
      { event_id: 'evt_refund_other', status: 'ignored', reason: 'not_ours' },
      { event_id: 'evt_refund_unknown', status: 'processed', reason: 'unmatched' },
    ]);
    expect(t.adjs.map((a) => a.ctx.known)).toEqual([false]);
  });
});

describe('shared seller account: reconcile', () => {
  it('skips subscriptions that are not ours', async () => {
    const t = setup({ owns: { priceIds: [SEAT_PRICE] } });
    const sub = (id: string, priceId: string) => ({
      ...loadFixture('subscription.created').data, id, items: [{ price: { id: priceId, product_id: 'pro_x' }, quantity: 1 }],
    });
    const fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [sub('sub_ours', SEAT_PRICE), sub('sub_theirs', 'pri_other')], meta: { pagination: { has_more: false } } }) });
    const result = await reconcile(t.billing, { apiKey: 'pdl_sdbx_x', fetch });
    expect(result).toEqual({ scanned: 2, applied: 1, notOurs: 1, invalid: 0 });
    expect(await t.store.getSubscription('sub_theirs')).toBeNull();
    expect(await t.store.getSubscription('sub_ours')).not.toBeNull();
  });
});
