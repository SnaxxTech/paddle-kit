import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adjustment, Transaction } from '../src/core';
import { createFulfilment, drainOutbox, enqueue, outboxCheck, type FulfilmentActions, type SqlTx } from '../src/fulfil';
import { MIGRATIONS } from '../src/postgres';

// paddle-kit/fulfil on real SQL (PGlite with the kit's migrations). The app's part is tiny: an accounts table and
// what grant / revoke / restore mean for it. Every scenario of the README examples runs through the module.
const dbs: PGlite[] = [];
afterEach(async () => { await Promise.all(dbs.splice(0).map((d) => d.close())); });

async function database() {
  const pg = new PGlite();
  dbs.push(pg);
  for (const m of MIGRATIONS) await pg.exec(m.sql);
  await pg.exec('CREATE TABLE accounts (user_id text PRIMARY KEY, credits int NOT NULL CHECK (credits >= 0))');
  const db = { transaction: <T>(fn: (q: SqlTx) => Promise<T>) => pg.transaction((t) => fn(t as unknown as SqlTx)) };
  return { pg, db };
}

// A credit pack: 5 credits per unit of pri_pack.
const credits: FulfilmentActions<{ credits: number }> = {
  orderOf: (tx) => {
    const userId = tx.customData?.userId;
    const ok = tx.items.length > 0 && tx.items.every((i) => i.priceId === 'pri_pack');
    return typeof userId === 'string' && ok ? { userId, grants: { credits: 5 * tx.items.reduce((n, i) => n + i.quantity, 0) } } : null;
  },
  async grant(q, f) {
    await q.query('INSERT INTO accounts (user_id, credits) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET credits = accounts.credits + $2', [f.userId, f.grants.credits]);
    await enqueue(q, { id: `${f.transactionId}:receipt`, kind: 'receipt', payload: { userId: f.userId, credits: f.grants.credits } });
  },
  async revoke(q, f) {
    const balance = (await q.query('SELECT credits FROM accounts WHERE user_id = $1 FOR UPDATE', [f.userId])).rows[0]?.credits ?? 0;
    const take = Math.min(balance, f.grants.credits);
    await q.query('UPDATE accounts SET credits = credits - $1 WHERE user_id = $2', [take, f.userId]);
    return take;
  },
  async restore(q, f) {
    await q.query('UPDATE accounts SET credits = credits + $1 WHERE user_id = $2', [Number(f.taken), f.userId]);
  },
};

function harness(pg: PGlite, db: Parameters<typeof createFulfilment>[0], actions: FulfilmentActions<any> = credits) {
  const hooks = createFulfilment(db, actions);
  const ctx = { eventId: 'e', eventType: 't', store: {} as any, known: true };
  const pay = (id: string, o: { quantity?: number; price?: string; userId?: string | null; subscriptionId?: string | null } = {}) =>
    hooks.onTransaction!({
      transactionId: id, status: 'completed', customerId: null, subscriptionId: o.subscriptionId ?? null,
      customData: o.userId === null ? null : { userId: o.userId ?? 'u1' }, items: [{ priceId: o.price ?? 'pri_pack', productId: null, quantity: o.quantity ?? 1 }],
      currency: 'USD', total: '1500', subtotal: '1500', occurredAt: '', raw: {},
    } as Transaction, ctx);
  const adjust = (adjustmentId: string, transactionId: string, action: string, status: string, type: 'full' | 'partial' = 'full') =>
    hooks.onAdjustment!({ adjustmentId, transactionId, action, status, type, subscriptionId: null, customerId: null, currency: 'USD', total: '1500', subtotal: '1500', occurredAt: '', raw: {} } as Adjustment, ctx);
  const balance = async (u = 'u1') => (await pg.query<{ credits: number }>('SELECT credits FROM accounts WHERE user_id = $1', [u])).rows[0]?.credits ?? 0;
  const reviews = async () => (await pg.query<{ kind: string; transaction_id: string }>('SELECT kind, transaction_id FROM paddle_fulfilment_reviews ORDER BY id')).rows;
  const state = async (id: string) => (await pg.query<{ state: string }>('SELECT state FROM paddle_fulfilments WHERE transaction_id = $1', [id])).rows[0]?.state;
  return { pay, adjust, balance, reviews, state };
}

describe('createFulfilment: a credit pack', () => {
  it('a payment grants by quantity once; replays change nothing; the receipt is queued once', async () => {
    const { pg, db } = await database();
    const t = harness(pg, db);
    await t.pay('txn_1', { quantity: 2 });
    await t.pay('txn_1', { quantity: 2 });
    expect(await t.balance()).toBe(10);
    expect(await t.state('txn_1')).toBe('granted');
    expect((await pg.query('SELECT id, kind FROM paddle_outbox')).rows).toEqual([{ id: 'txn_1:receipt', kind: 'receipt' }]);
  });

  it('buy 5, spend 3, refund, reverse: 2 come back, not 5 (chargeback and a won dispute too)', async () => {
    const { pg, db } = await database();
    const t = harness(pg, db);
    await t.pay('txn_1');
    await pg.query(`UPDATE accounts SET credits = 2 WHERE user_id = 'u1'`);
    await t.adjust('adj_r', 'txn_1', 'refund', 'approved');
    expect(await t.balance()).toBe(0);
    await t.adjust('adj_r', 'txn_1', 'refund', 'reversed');
    expect(await t.balance()).toBe(2);
    await t.adjust('adj_cb', 'txn_1', 'chargeback', 'approved');
    expect(await t.balance()).toBe(0);
    await t.adjust('adj_cbr', 'txn_1', 'chargeback_reverse', 'approved');
    expect(await t.balance()).toBe(2);
  });

  it('a refund that arrived before its payment: nothing granted, held; its reversal grants it', async () => {
    const { pg, db } = await database();
    const t = harness(pg, db);
    await t.adjust('adj_r', 'txn_1', 'refund', 'approved');
    await t.pay('txn_1');
    expect(await t.balance()).toBe(0);
    expect(await t.state('txn_1')).toBe('held');
    await t.adjust('adj_r', 'txn_1', 'refund', 'reversed');
    expect(await t.balance()).toBe(5);
  });

  it('a won chargeback restores nothing while a separate refund stands; an older status delivered late changes nothing', async () => {
    const { pg, db } = await database();
    const t = harness(pg, db);
    await t.pay('txn_1');
    await t.adjust('adj_r', 'txn_1', 'refund', 'approved');
    await t.adjust('adj_cb', 'txn_1', 'chargeback', 'approved');
    await t.adjust('adj_cbr', 'txn_1', 'chargeback_reverse', 'approved');
    expect(await t.balance()).toBe(0);
    await t.adjust('adj_r', 'txn_1', 'refund', 'reversed');
    await t.adjust('adj_r', 'txn_1', 'refund', 'approved'); // late redelivery of the earlier status
    expect(await t.balance()).toBe(5);
  });

  it('partial refunds and chargeback warnings become reviews; an unknown price or no user is a review, once', async () => {
    const { pg, db } = await database();
    const t = harness(pg, db);
    await t.pay('txn_1');
    await t.adjust('adj_p', 'txn_1', 'refund', 'approved', 'partial');
    await t.adjust('adj_w', 'txn_1', 'chargeback_warning', 'approved');
    expect(await t.balance()).toBe(5);
    await t.pay('txn_2', { price: 'pri_other' });
    await t.pay('txn_2', { price: 'pri_other' });
    await t.pay('txn_3', { userId: null });
    expect(await t.reviews()).toEqual([
      { kind: 'refund', transaction_id: 'txn_1' }, { kind: 'chargeback_warning', transaction_id: 'txn_1' },
      { kind: 'unfulfilled_payment', transaction_id: 'txn_2' }, { kind: 'unfulfilled_payment', transaction_id: 'txn_3' },
    ]);
  });

  it('subscription payments are left to entitlements', async () => {
    const { pg, db } = await database();
    const t = harness(pg, db);
    await t.pay('txn_sub', { subscriptionId: 'sub_1' });
    expect(await t.balance()).toBe(0);
    expect((await pg.query('SELECT count(*)::int AS n FROM paddle_fulfilments')).rows).toEqual([{ n: 0 }]);
  });

  it('when the app\'s action throws, nothing of that payment is kept: the retry grants exactly once', async () => {
    const { pg, db } = await database();
    let fail = true;
    const flaky: FulfilmentActions<{ credits: number }> = { ...credits, async grant(q, f) { await credits.grant(q, f); if (fail) throw new Error('db down'); } };
    const t = harness(pg, db, flaky);
    await expect(t.pay('txn_1')).rejects.toThrow('db down');
    expect(await t.balance()).toBe(0);
    expect(await t.state('txn_1')).toBeUndefined();
    fail = false;
    await t.pay('txn_1');
    expect(await t.balance()).toBe(5);
    expect((await pg.query('SELECT count(*)::int AS n FROM paddle_outbox')).rows).toEqual([{ n: 1 }]);
  });
});

describe('createFulfilment: a one-time unlock', () => {
  it('unlock, lock on refund, unlock on reversal; revoke measures nothing', async () => {
    const { pg, db } = await database();
    await pg.exec('CREATE TABLE unlocks (user_id text, feature text, PRIMARY KEY (user_id, feature))');
    const unlock: FulfilmentActions<{ feature: string }> = {
      orderOf: (tx) => (typeof tx.customData?.userId === 'string' && tx.items.some((i) => i.priceId === 'pri_life') ? { userId: tx.customData.userId as string, grants: { feature: 'pro' } } : null),
      grant: async (q, f) => { await q.query('INSERT INTO unlocks VALUES ($1, $2) ON CONFLICT DO NOTHING', [f.userId, f.grants.feature]); },
      revoke: async (q, f) => { await q.query('DELETE FROM unlocks WHERE user_id = $1 AND feature = $2', [f.userId, f.grants.feature]); return null; },
      restore: async (q, f) => { await q.query('INSERT INTO unlocks VALUES ($1, $2) ON CONFLICT DO NOTHING', [f.userId, f.grants.feature]); },
    };
    const t = harness(pg, db, unlock);
    const has = async () => (await pg.query('SELECT 1 FROM unlocks WHERE user_id = $1', ['u1'])).rows.length > 0;
    await t.pay('txn_1', { price: 'pri_life' });
    expect(await has()).toBe(true);
    await t.adjust('adj_f', 'txn_1', 'refund', 'approved');
    expect(await has()).toBe(false);
    await t.adjust('adj_f', 'txn_1', 'refund', 'reversed');
    expect(await has()).toBe(true);
  });
});

describe('outbox', () => {
  it('drains due items once; a failing handler is retried later with backoff and its error kept, redacted', async () => {
    const { pg, db } = await database();
    await db.transaction(async (q) => {
      await enqueue(q, { id: 'a', kind: 'email', payload: { to: 'u1' } });
      await enqueue(q, { id: 'a', kind: 'email', payload: { to: 'other' } }); // same key: kept once
      await enqueue(q, { id: 'b', kind: 'job', payload: { n: 1 } });
    });
    const seen: string[] = [];
    const handlers = {
      email: async (p: any, item: { id: string }) => { seen.push(`${item.id}:${p.to}`); },
      job: async () => { throw new Error('failed with pdl_sdbx_apikey_secret0123456789'); },
    };
    const query = (t: string, p?: unknown[]) => pg.query(t, p);
    expect(await drainOutbox(query, handlers)).toEqual({ sent: 1, failed: 1, gaveUp: 0, lost: 0 });
    expect(await drainOutbox(query, handlers)).toEqual({ sent: 0, failed: 0, gaveUp: 0, lost: 0 }); // b waits for its backoff
    expect(seen).toEqual(['a:u1']);
    const b = (await pg.query<any>(`SELECT attempts, last_error, next_at > now() + interval '50 seconds' AS later FROM paddle_outbox WHERE id = 'b'`)).rows[0];
    expect(b).toMatchObject({ attempts: 1, later: true });
    expect(b.last_error).toContain('Error: failed with');
    expect(b.last_error).not.toContain('secret0123456789');
  });

  it('gives up after maxAttempts; outboxCheck turns red for it and for late items, green when all are sent', async () => {
    const { pg, db } = await database();
    const query = (t: string, p?: unknown[]) => pg.query(t, p);
    expect(await outboxCheck(query)()).toEqual({ ok: true });
    await db.transaction((q) => enqueue(q, { id: 'x', kind: 'email', payload: {} }));
    const fail = { email: async () => { throw new Error('smtp down'); } };
    for (let i = 0; i < 2; i++) {
      await pg.query(`UPDATE paddle_outbox SET next_at = now() - interval '1 second'`);
      await drainOutbox(query, fail, { maxAttempts: 2 });
    }
    expect((await pg.query<any>('SELECT attempts FROM paddle_outbox')).rows[0].attempts).toBe(2);
    expect(await outboxCheck(query, { maxAttempts: 2 })()).toEqual({ ok: false, detail: '1 gave up, 0 waiting over 60 min (oldest: email)' });
    await pg.query(`UPDATE paddle_outbox SET attempts = 0, next_at = now() - interval '1 second', created_at = now() - interval '2 hours'`);
    expect((await outboxCheck(query)()).detail).toBe('0 gave up, 1 waiting over 60 min (oldest: email)');
    await drainOutbox(query, { email: async () => {} });
    expect(await outboxCheck(query)()).toEqual({ ok: true });
  });

  it('an item of a kind with no handler is not dropped: it fails, visibly', async () => {
    const { pg, db } = await database();
    await db.transaction((q) => enqueue(q, { id: 'k', kind: 'sms', payload: {} }));
    expect(await drainOutbox((t, p) => pg.query(t, p), {})).toEqual({ sent: 0, failed: 1, gaveUp: 0, lost: 0 });
    expect((await pg.query<any>('SELECT last_error FROM paddle_outbox')).rows[0].last_error).toBe('Error: no handler for kind "sms"');
  });
});

describe('wiring: the recovery route drains the outbox, readiness checks migration 005', () => {
  it('createRecoveryRoute({ drainOutbox }) adds its result; a throw is a 500 with the error name only', async () => {
    const { createRecoveryRoute } = await import('../src/reconcile');
    const { createBilling } = await import('../src/core');
    const { memoryStore } = await import('../src/memory');
    const billing = createBilling({ environment: 'sandbox', webhookSecret: 's', store: memoryStore(), entitlements: {}, owns: () => true });
    const paddle = async () => Response.json({ data: [], meta: { pagination: { has_more: false } } });
    const get = (drainOutbox: () => Promise<unknown>) =>
      createRecoveryRoute({ billing, problems: [], apiKey: 'pdl_sdbx_k', cronSecret: 's'.repeat(20), recovery: { fetch: paddle as any }, drainOutbox })
        .GET(new Request('https://app.test/', { headers: { authorization: `Bearer ${'s'.repeat(20)}` } }));
    const ok = await get(async () => ({ sent: 3, failed: 0, gaveUp: 0 }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: 'done', outbox: { sent: 3 } });
    const bad = await get(async () => { throw new TypeError('connect ECONNREFUSED postgres://user:pw@host'); });
    expect(bad.status).toBe(500);
    const body = await bad.json();
    expect(body.outbox).toEqual({ error: 'TypeError' });
    expect(JSON.stringify(body)).not.toContain('pw@host');
  });

  it('readinessChecks({ fulfilment: true }) checks migration 005; without the option it is not required', async () => {
    const { readinessChecks } = await import('../src/config');
    const { postgresStore } = await import('../src/postgres');
    const { pg } = await database();
    const store = postgresStore({ query: (t, p) => pg.query(t, p) as any });
    const migrations = (fulfilment?: boolean) => readinessChecks({ apiKey: undefined, environment: 'sandbox', store, fulfilment }).migrations!();
    expect(await migrations(true)).toEqual({ ok: true });
    await pg.exec('DROP TABLE paddle_outbox');
    expect(await migrations(true)).toEqual({ ok: false, detail: 'missing paddle_outbox (run 005_fulfilment_outbox)' });
    expect(await migrations()).toEqual({ ok: true });
  });
});

// The six gaps the first real consumer (Slop Remover's Full Scan) found. Each test failed on 0db6ccd.
describe('fulfil: gaps found by the Slop Remover port', () => {
  async function kit() {
    return import('../src/fulfil');
  }

  it('1. grant may decline: state declined plus a review; a later refund does not call revoke', async () => {
    const { pg, db } = await database();
    const calls: string[] = [];
    const picky: FulfilmentActions<{ credits: number }> = {
      ...credits,
      // async, inside the payment's lock, with the app's transaction
      orderOf: async (tx, q) => ((await q.query('SELECT 1 AS ok')).rows[0].ok === 1 ? credits.orderOf(tx, q) : null),
      grant: async (_q, f) => { calls.push(`grant:${f.transactionId}`); return { declined: 'order_already_paid' }; },
      revoke: async (q, f) => { calls.push('revoke'); return credits.revoke(q, f); },
    };
    const t = harness(pg, db, picky);
    await t.pay('txn_1');
    expect(await t.state('txn_1')).toBe('declined');
    expect(await t.reviews()).toEqual([{ kind: 'declined:order_already_paid', transaction_id: 'txn_1' }]);
    await t.adjust('adj_r', 'txn_1', 'refund', 'approved');
    expect(calls).toEqual(['grant:txn_1']);
  });

  it('2. importFulfilment: a pre-kit paid order honours its later refund; a pre-kit refunded order is not restored by an unrelated event', async () => {
    const { importFulfilment } = await kit();
    const { pg, db } = await database();
    await pg.query(`INSERT INTO accounts VALUES ('u1', 5), ('u2', 0)`);
    await db.transaction(async (q) => {
      expect(await importFulfilment(q, { transactionId: 'txn_old_paid', userId: 'u1', grants: { credits: 5 }, state: 'granted' })).toBe(true);
      expect(await importFulfilment(q, { transactionId: 'txn_old_paid', userId: 'u1', grants: { credits: 5 }, state: 'granted' })).toBe(false);
      await importFulfilment(q, { transactionId: 'txn_old_refunded', userId: 'u2', grants: { credits: 5 }, state: 'revoked', revokedBy: 'refund', adjustmentId: 'adj_old_r', taken: 5 });
    });
    const t = harness(pg, db);
    await t.adjust('adj_r', 'txn_old_paid', 'refund', 'approved');
    expect(await t.balance('u1')).toBe(0);
    await t.adjust('adj_w', 'txn_old_refunded', 'chargeback_warning', 'approved'); // unrelated: must not restore
    expect(await t.balance('u2')).toBe(0);
    expect(await t.state('txn_old_refunded')).toBe('revoked');
  });

  it('3. revoke and restore are told the adjustment that caused them', async () => {
    const { pg, db } = await database();
    const causes: string[] = [];
    const told: FulfilmentActions<{ credits: number }> = {
      ...credits,
      revoke: async (q, f) => { causes.push(`revoke:${f.cause?.action}:${f.cause?.adjustmentId}`); return credits.revoke(q, f); },
      restore: async (q, f) => { causes.push(`restore:${f.cause?.action}:${f.cause?.status}`); return credits.restore(q, f); },
    };
    const t = harness(pg, db, told);
    await t.pay('txn_1');
    await t.adjust('adj_cb', 'txn_1', 'chargeback', 'approved');
    await t.adjust('adj_cbr', 'txn_1', 'chargeback_reverse', 'approved');
    expect(causes).toEqual(['revoke:chargeback:adj_cb', 'restore:chargeback_reverse:approved']);
  });

  it('4. fulfilmentState reads a payment: state, what it grants, and what revoked it', async () => {
    const { fulfilmentState } = await kit();
    const { pg, db } = await database();
    const t = harness(pg, db);
    const read = (id: string) => db.transaction((q) => fulfilmentState(q, id));
    expect(await read('txn_x')).toBeNull();
    await t.pay('txn_1');
    expect(await read('txn_1')).toMatchObject({ state: 'granted', userId: 'u1', grants: { credits: 5 }, revokedBy: null });
    await t.adjust('adj_cb', 'txn_1', 'chargeback', 'approved');
    expect(await read('txn_1')).toMatchObject({ state: 'revoked', revokedBy: 'chargeback', taken: 5 });
    await t.adjust('adj_r', 'txn_2', 'refund', 'approved');
    await t.pay('txn_2');
    expect(await read('txn_2')).toMatchObject({ state: 'held', revokedBy: 'refund' });
  });

  it('5. a payment held because its refund came first raises a held_payment review, once', async () => {
    const { pg, db } = await database();
    const t = harness(pg, db);
    await t.adjust('adj_r', 'txn_1', 'refund', 'approved');
    await t.pay('txn_1');
    await t.pay('txn_1');
    expect(await t.reviews()).toEqual([{ kind: 'held_payment', transaction_id: 'txn_1' }]);
  });

  it('6. onReview is called once for each new kit review, in the same transaction', async () => {
    const { createFulfilment } = await kit();
    const { pg, db } = await database();
    await pg.exec('CREATE TABLE app_alerts (id text PRIMARY KEY, kind text)');
    const seen: string[] = [];
    const hooks = createFulfilment(db, credits, {
      onReview: async (q, r) => { seen.push(`${r.kind}:${r.transactionId}`); await q.query('INSERT INTO app_alerts VALUES ($1, $2)', [r.id, r.kind]); },
    });
    const ctx = { eventId: 'e', eventType: 't', store: {} as any, known: true };
    const adj = (status: string) => hooks.onAdjustment!({ adjustmentId: 'adj_p', transactionId: 'txn_1', action: 'refund', status, type: 'partial', subscriptionId: null, customerId: null, currency: 'USD', total: '1', subtotal: '1', occurredAt: '', raw: {} } as Adjustment, ctx);
    await adj('approved');
    await adj('approved'); // redelivery: no second review, no second call
    expect(seen).toEqual(['refund:txn_1']);
    expect((await pg.query('SELECT kind FROM app_alerts')).rows).toEqual([{ kind: 'refund' }]);
  });
});

describe('importFulfilment keeps the real adjustment (third review)', () => {
  // A refund is reversed by a status change on its own adjustment id; a replayed chargeback must not count twice.
  async function imported(revokedBy: 'refund' | 'chargeback', adjustmentId: string) {
    const { importFulfilment } = await import('../src/fulfil');
    const { pg, db } = await database();
    await pg.query(`INSERT INTO accounts VALUES ('u1', 0)`);
    await db.transaction((q) => importFulfilment(q, { transactionId: 'txn_old', userId: 'u1', grants: { credits: 5 }, state: 'revoked', revokedBy, adjustmentId, taken: 5 } as any));
    return { t: harness(pg, db), pg, db, importFulfilment };
  }

  it('the real reversal of the imported refund gives the order back', async () => {
    const { t } = await imported('refund', 'adj_r0');
    await t.adjust('adj_r0', 'txn_old', 'refund', 'approved'); // a recovery replay of the original: no change
    expect(await t.state('txn_old')).toBe('revoked');
    await t.adjust('adj_r0', 'txn_old', 'refund', 'reversed');
    expect(await t.state('txn_old')).toBe('granted');
    expect(await t.balance()).toBe(5);
  });

  it('an unrelated reversal does not clear the imported refund', async () => {
    const { t } = await imported('refund', 'adj_r0');
    await t.adjust('adj_other', 'txn_old', 'refund', 'approved', 'partial');
    await t.adjust('adj_other', 'txn_old', 'refund', 'reversed', 'partial');
    await t.adjust('adj_cbr', 'txn_old', 'chargeback_reverse', 'approved');
    expect(await t.state('txn_old')).toBe('revoked');
    expect(await t.balance()).toBe(0);
  });

  it('a replayed imported chargeback counts once, so its reversal gives the order back', async () => {
    const { t } = await imported('chargeback', 'adj_cb0');
    await t.adjust('adj_cb0', 'txn_old', 'chargeback', 'approved');
    await t.adjust('adj_cbr', 'txn_old', 'chargeback_reverse', 'approved');
    expect(await t.state('txn_old')).toBe('granted');
  });

  it('a revoked import without the adjustment id is refused', async () => {
    const { db, importFulfilment } = await imported('refund', 'adj_r0');
    await expect(db.transaction((q) => importFulfilment(q, { transactionId: 'txn_2', userId: 'u1', grants: {}, state: 'revoked', revokedBy: 'refund' } as any)))
      .rejects.toThrow(/adjustmentId/);
  });
});

describe('outbox and import edge cases (third review, independent pass)', () => {
  it('the claim token does not depend on the session DateStyle', async () => {
    const { pg, db } = await database();
    await db.transaction((q) => enqueue(q, { id: 'x', kind: 'email', payload: {} }));
    let n = 0; // every statement in another DateStyle, as on a pool whose connections disagree
    const query = async (t: string, p?: unknown[]) => { await pg.exec(`SET datestyle = '${n++ % 2 ? 'SQL, DMY' : 'SQL, MDY'}'`); return pg.query(t, p); };
    expect(await drainOutbox(query as any, { email: async () => {} })).toMatchObject({ sent: 1, lost: 0 });
  });

  it('importFulfilment refuses an adjustment id that belongs to another payment', async () => {
    const { importFulfilment } = await import('../src/fulfil');
    const { db } = await database();
    const imp = (txn: string) => db.transaction((q) => importFulfilment(q, { transactionId: txn, userId: 'u1', grants: {}, state: 'revoked', revokedBy: 'refund', adjustmentId: 'adj_same', taken: 1 }));
    await imp('txn_1');
    await expect(imp('txn_2')).rejects.toThrow(/adj_same/);
  });
});
