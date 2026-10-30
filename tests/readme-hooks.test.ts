import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { adjustmentEffect, type BillingConfig } from '../src/core';
import type { Adjustment, Transaction } from '../src/core/types';

// The README's "One-time purchases and refunds" example, verbatim apart from `db`, run against real SQL (PGlite).
type Tx = { query(text: string, params?: unknown[]): Promise<{ rows: any[] }> };
async function setup() {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE orders (id text PRIMARY KEY, user_id text, credits int, currency text, total text);
    CREATE TABLE applied (id text PRIMARY KEY, order_id text, effect text);
    CREATE TABLE reviews (id text PRIMARY KEY, kind text, detail text);
    CREATE TABLE accounts (user_id text PRIMARY KEY, credits int CHECK (credits >= 0));`);
  const db = { transaction: <T>(fn: (q: Tx) => Promise<T>) => pg.transaction((t) => fn(t as unknown as Tx)) };
  const review = (q: Tx, id: string, kind: string, detail: string) =>
    q.query('INSERT INTO reviews (id, kind, detail) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, kind, detail]);

  function packHooks(packPriceId: string, creditsPerUnit = 5): Pick<BillingConfig, 'onTransaction' | 'onAdjustment'> {
    return {
      onTransaction: async (tx) => {
        if (tx.subscriptionId !== null) return;
        const userId = tx.customData?.userId;
        const known = tx.items.length > 0 && tx.items.every((i) => i.priceId === packPriceId);
        await db.transaction(async (q) => {
          if (typeof userId !== 'string' || !known) {
            await review(q, `txn:${tx.transactionId}`, 'unfulfilled_order', `${tx.currency} ${tx.total}`);
            return;
          }
          const credits = creditsPerUnit * tx.items.reduce((n, i) => n + i.quantity, 0);
          const ins = await q.query(
            'INSERT INTO orders (id, user_id, credits, currency, total) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id',
            [tx.transactionId, userId, credits, tx.currency, tx.total],
          );
          if (ins.rows.length === 0) return;
          await q.query(
            'INSERT INTO accounts (user_id, credits) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET credits = accounts.credits + EXCLUDED.credits',
            [userId, credits],
          );
        });
      },
      onAdjustment: async (adj) => {
        const effect = adjustmentEffect(adj);
        if (effect === 'none') return;
        await db.transaction(async (q) => {
          const order = (await q.query('SELECT id, user_id, credits FROM orders WHERE id = $1', [adj.transactionId])).rows[0];
          if (effect === 'review' || !order) {
            await review(q, `adj:${adj.adjustmentId}:${adj.status}`, `${adj.action}${order ? '' : '_unknown_order'}`, `${adj.currency} ${adj.total}`);
            return;
          }
          if (effect === 'restore') {
            const open = (await q.query(
              "SELECT count(*) FILTER (WHERE effect = 'revoke') - count(*) FILTER (WHERE effect = 'restore') AS n FROM applied WHERE order_id = $1",
              [order.id],
            )).rows[0];
            if (Number(open?.n ?? 0) <= 0) return;
          }
          const ins = await q.query('INSERT INTO applied (id, order_id, effect) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id', [`${adj.adjustmentId}:${adj.status}`, order.id, effect]);
          if (ins.rows.length === 0) return;
          const delta = effect === 'revoke' ? -order.credits : order.credits;
          await q.query('UPDATE accounts SET credits = GREATEST(credits + $1, 0) WHERE user_id = $2', [delta, order.user_id]);
        });
      },
    };
  }
  const hooks = packHooks('pri_pack');
  const ctx = { eventId: 'e', eventType: 't', store: {} as any, known: true };
  const pay = (id: string, quantity = 1) =>
    hooks.onTransaction!({ transactionId: id, status: 'completed', customerId: null, subscriptionId: null, customData: { userId: 'u1' }, items: [{ priceId: 'pri_pack', productId: null, quantity }], currency: 'USD', total: '1500', subtotal: '1500', occurredAt: '', raw: {} } as Transaction, ctx);
  const adjust = (adjustmentId: string, transactionId: string, action: string, status: string, type: 'full' | 'partial' = 'full') =>
    hooks.onAdjustment!({ adjustmentId, transactionId, action, status, type, subscriptionId: null, customerId: null, currency: 'USD', total: '1500', subtotal: '1500', occurredAt: '', raw: {} } as Adjustment, ctx);
  const credits = async () => (await pg.query<{ credits: number }>('SELECT credits FROM accounts WHERE user_id = $1', ['u1'])).rows[0]?.credits;
  const reviews = async () => (await pg.query<{ kind: string }>('SELECT kind FROM reviews ORDER BY id')).rows.map((r) => r.kind);
  return { pay, adjust, credits, reviews };
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

  it('partial refund, chargeback warning and an unknown order go to review; credits never go below zero', async () => {
    const t = await setup();
    await t.pay('txn_1');
    await t.adjust('adj_p', 'txn_1', 'refund', 'approved', 'partial');
    await t.adjust('adj_w', 'txn_1', 'chargeback_warning', 'approved');
    await t.adjust('adj_u', 'txn_unknown', 'refund', 'approved');
    expect(await t.credits()).toBe(5);
    expect((await t.reviews()).sort()).toEqual(['chargeback_warning', 'refund', 'refund_unknown_order']);
  });
});
