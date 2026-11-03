import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import * as core from '../src/core';
import type { Adjustment, Transaction } from '../src/core';
import { readmePackHooks, readmeSql, type Tx } from './helpers/readme-example';

// The README's "One-time purchases and refunds" example, read out of README.md and run as written on real SQL (PGlite).
async function setup() {
  const pg = new PGlite();
  await pg.exec(readmeSql);
  const db = { transaction: <T>(fn: (q: Tx) => Promise<T>) => pg.transaction((t) => fn(t as unknown as Tx)) };
  const hooks = readmePackHooks(db)('pri_pack');
  const ctx = { eventId: 'e', eventType: 't', store: {} as any, known: true };
  const pay = (id: string, quantity = 1) =>
    hooks.onTransaction!({ transactionId: id, status: 'completed', customerId: null, subscriptionId: null, customData: { userId: 'u1' }, items: [{ priceId: 'pri_pack', productId: null, quantity }], currency: 'USD', total: '1500', subtotal: '1500', occurredAt: '', raw: {} } as Transaction, ctx);
  const adjust = (adjustmentId: string, transactionId: string, action: string, status: string, type: 'full' | 'partial' = 'full') =>
    hooks.onAdjustment!({ adjustmentId, transactionId, action, status, type, subscriptionId: null, customerId: null, currency: 'USD', total: '1500', subtotal: '1500', occurredAt: '', raw: {} } as Adjustment, ctx);
  const credits = async () => (await pg.query<{ credits: number }>('SELECT credits FROM accounts WHERE user_id = $1', ['u1'])).rows[0]?.credits ?? 0;
  const reviews = async () => (await pg.query<{ kind: string }>('SELECT kind FROM reviews ORDER BY id')).rows.map((r) => r.kind);
  return { pg, pay, adjust, credits, reviews };
}

describe('README hooks example on real SQL', () => {
  it('chargeback takes the credits, a won dispute gives them back once; redeliveries change nothing', async () => {
    const t = await setup();
    await t.pay('txn_1', 2);
    expect(await t.credits()).toBe(10);
    await t.adjust('adj_cb', 'txn_1', 'chargeback', 'approved');
    await t.adjust('adj_cb', 'txn_1', 'chargeback', 'approved'); // redelivery / reconcile replay
    expect(await t.credits()).toBe(0);
    await t.adjust('adj_cbr', 'txn_1', 'chargeback_reverse', 'approved');
    await t.adjust('adj_cbr', 'txn_1', 'chargeback_reverse', 'approved');
    expect(await t.credits()).toBe(10);
  });

  it('full refund revokes; refund reversed restores; a restore with nothing taken back gives nothing', async () => {
    const t = await setup();
    await t.pay('txn_1');
    await t.adjust('adj_r', 'txn_1', 'refund', 'pending_approval');
    expect(await t.credits()).toBe(5);
    await t.adjust('adj_r', 'txn_1', 'refund', 'approved');
    expect(await t.credits()).toBe(0);
    await t.adjust('adj_r', 'txn_1', 'refund', 'reversed');
    expect(await t.credits()).toBe(5);
    await t.adjust('adj_x', 'txn_1', 'chargeback_reverse', 'approved'); // no open revoke: nothing to give back
    expect(await t.credits()).toBe(5);
  });

  it('partial refund and chargeback warning go to review; credits never go below zero', async () => {
    const t = await setup();
    await t.pay('txn_1');
    await t.adjust('adj_p', 'txn_1', 'refund', 'approved', 'partial');
    await t.adjust('adj_w', 'txn_1', 'chargeback_warning', 'approved');
    expect(await t.credits()).toBe(5);
    expect((await t.reviews()).sort()).toEqual(['chargeback_warning', 'refund']);
    await t.pg.query(`UPDATE accounts SET credits = 2 WHERE user_id = 'u1'`); // 3 credits spent
    await t.adjust('adj_r', 'txn_1', 'refund', 'approved');
    expect(await t.credits()).toBe(0);
  });

  it('a refund that arrived before its payment: the payment grants nothing, and is kept against the transaction', async () => {
    const t = await setup();
    await t.adjust('adj_r', 'txn_1', 'refund', 'approved');
    await t.pay('txn_1');
    await t.pay('txn_1'); // replay
    expect(await t.credits()).toBe(0);
    expect((await t.pg.query('SELECT granted FROM orders')).rows).toEqual([{ granted: 0 }]);
    await t.adjust('adj_r', 'txn_1', 'refund', 'reversed'); // and a refund reversed later still gives them
    expect(await t.credits()).toBe(5);
  });

  it('a won chargeback restores nothing while a separate full refund still stands', async () => {
    const t = await setup();
    await t.pay('txn_1');
    await t.adjust('adj_r', 'txn_1', 'refund', 'approved');
    await t.adjust('adj_cb', 'txn_1', 'chargeback', 'approved');
    await t.adjust('adj_cbr', 'txn_1', 'chargeback_reverse', 'approved');
    expect(await t.credits()).toBe(0);
    await t.adjust('adj_r', 'txn_1', 'refund', 'reversed'); // the refund undone too: now nothing takes it back
    expect(await t.credits()).toBe(5);
  });

  it('a reversed refund gives back only what the refund took: spent credits stay spent', async () => {
    const t = await setup();
    await t.pay('txn_1');
    await t.pg.query(`UPDATE accounts SET credits = 2 WHERE user_id = 'u1'`); // 3 of 5 spent
    await t.adjust('adj_r', 'txn_1', 'refund', 'approved');
    expect(await t.credits()).toBe(0); // the 2 left were taken back
    await t.adjust('adj_r', 'txn_1', 'refund', 'reversed');
    expect(await t.credits()).toBe(2); // the 2 come back, not 5
    await t.adjust('adj_cb', 'txn_1', 'chargeback', 'approved');
    expect(await t.credits()).toBe(0);
    await t.adjust('adj_cbr', 'txn_1', 'chargeback_reverse', 'approved');
    expect(await t.credits()).toBe(2);
  });

  it('a revoke while other packs fund the balance takes this pack back in full, and a restore returns it', async () => {
    const t = await setup();
    await t.pay('txn_1');
    await t.pay('txn_2');
    await t.adjust('adj_r', 'txn_1', 'refund', 'approved');
    expect(await t.credits()).toBe(5);
    await t.adjust('adj_r', 'txn_1', 'refund', 'reversed');
    expect(await t.credits()).toBe(10);
  });

  it('an older status delivered late changes nothing', async () => {
    const t = await setup();
    await t.pay('txn_1');
    await t.adjust('adj_r', 'txn_1', 'refund', 'reversed');
    await t.adjust('adj_r', 'txn_1', 'refund', 'approved'); // late redelivery of the earlier status
    expect(await t.credits()).toBe(5);
  });

});

describe('paymentRevoked', () => {
  const a = (action: string, status: string, type: 'full' | 'partial' | null = 'full') => ({ action, status, type });
  it('counts what still stands', () => {
    expect(core.paymentRevoked([])).toBe(false);
    expect(core.paymentRevoked([a('refund', 'approved')])).toBe(true);
    expect(core.paymentRevoked([a('refund', 'approved', 'partial')])).toBe(false);
    expect(core.paymentRevoked([a('refund', 'pending_approval'), a('refund', 'rejected'), a('refund', 'reversed')])).toBe(false);
    expect(core.paymentRevoked([a('chargeback', 'approved', null), a('chargeback_reverse', 'approved', null)])).toBe(false);
    expect(core.paymentRevoked([a('chargeback', 'approved', null), a('chargeback', 'approved', null), a('chargeback_reverse', 'approved', null)])).toBe(true);
    expect(core.paymentRevoked([a('refund', 'approved'), a('chargeback', 'approved', null), a('chargeback_reverse', 'approved', null)])).toBe(true);
  });
});
