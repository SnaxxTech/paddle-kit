// paddle-kit/db: one adapter per Postgres client the apps use, run on the real client (since v0.9.0).
// pg and @neondatabase/serverless's Pool share one API (fromPg); postgres-js (fromPostgresJs); PGlite (fromPglite).
// better-sqlite3 needs no adapter: sqliteStore(db) takes the Database itself (fulfilment is Postgres-only).
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { fromPg, fromPglite, fromPostgresJs, type Db } from '../src/db';
import { createFulfilment, enqueue, type FulfilmentActions } from '../src/fulfil';
import { MIGRATIONS, postgresStore } from '../src/postgres';
import type { Transaction, Adjustment } from '../src/core/types';
import { realPostgres } from './helpers/real-pg';
import { runStoreContract } from './helpers/store-contract';

const live = await realPostgres('real-Postgres adapter suite (pg, postgres-js)');
afterAll(async () => { await live?.stop(); });
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((f) => f())); });

const schema = () => `ad_${Math.random().toString(36).slice(2, 10)}`;
// One statement per query: PGlite's query (and postgres-js with parameters) runs a single statement.
const statements = (sql: string) => sql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean);
async function migrate(db: Db) {
  for (const m of MIGRATIONS) for (const st of statements(m.sql)) await db.query(st);
  await db.query('CREATE TABLE accounts (user_id text PRIMARY KEY, credits int NOT NULL)');
}

const credits: FulfilmentActions<{ credits: number }> = {
  orderOf: (tx) => ({ userId: String(tx.customData?.userId), grants: { credits: 5 } }),
  async grant(q, f) {
    await q.query('INSERT INTO accounts VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET credits = accounts.credits + $2', [f.userId, f.grants.credits]);
    await enqueue(q, { id: `${f.transactionId}:receipt`, kind: 'receipt', payload: { userId: f.userId } });
  },
  async revoke(q, f) { await q.query('UPDATE accounts SET credits = credits - $1 WHERE user_id = $2', [f.grants.credits, f.userId]); return f.grants.credits; },
  async restore(q, f) { await q.query('UPDATE accounts SET credits = credits + $1 WHERE user_id = $2', [Number(f.taken), f.userId]); },
};

function adapterContract(name: string, make: () => Promise<Db>) {
  describe(`adapter: ${name}`, () => {
    it('query takes $n parameters and answers { rows }', async () => {
      const db = await make();
      expect((await db.query('SELECT $1::int + 1 AS n, $2::text AS s', [1, 'x'])).rows).toEqual([{ n: 2, s: 'x' }]);
    });

    it('transaction commits, and rolls back everything when the callback throws', async () => {
      const db = await make();
      await db.query('CREATE TABLE t (v int)');
      await db.transaction(async (q) => { await q.query('INSERT INTO t VALUES (1)'); });
      await expect(db.transaction(async (q) => { await q.query('INSERT INTO t VALUES (2)'); throw new Error('boom'); })).rejects.toThrow('boom');
      expect((await db.query('SELECT v FROM t ORDER BY v')).rows).toEqual([{ v: 1 }]);
    });

    it('runs createFulfilment and the store end to end: grant + outbox, refund takes it back', async () => {
      const db = await make();
      await migrate(db);
      const hooks = createFulfilment(db, credits);
      const ctx = { eventId: 'e', eventType: 't', store: {} as never, known: true };
      await hooks.onTransaction!({ transactionId: 'txn_1', status: 'completed', customerId: null, subscriptionId: null, customData: { userId: 'u1' },
        items: [{ priceId: 'pri_pack', productId: null, quantity: 1 }], currency: 'USD', total: '500', subtotal: '500', occurredAt: '', raw: {} } as Transaction, ctx);
      expect((await db.query(`SELECT credits FROM accounts`)).rows).toEqual([{ credits: 5 }]);
      expect((await db.query(`SELECT id FROM paddle_outbox`)).rows).toEqual([{ id: 'txn_1:receipt' }]);
      await hooks.onAdjustment!({ adjustmentId: 'adj_1', transactionId: 'txn_1', action: 'refund', status: 'approved', type: 'full', subscriptionId: null,
        customerId: null, currency: 'USD', total: '500', subtotal: '500', occurredAt: '', raw: {} } as Adjustment, ctx);
      expect((await db.query(`SELECT credits FROM accounts`)).rows).toEqual([{ credits: 0 }]);
      const health = await postgresStore({ query: db.query }).health(new Date());
      expect(health.failedLast24h).toBe(0);
    });
  });
}

adapterContract('PGlite (fromPglite)', async () => {
  const pg = new PGlite();
  cleanups.push(() => pg.close());
  return fromPglite(pg);
});

if (live) {
  const { default: pg } = (await import('pg' as string)) as { default: any };
  const { default: postgres } = await import('postgres');
  const pgDb = async () => {
    const s = schema();
    const admin = new pg.Pool({ connectionString: live.url, max: 1 });
    await admin.query(`CREATE SCHEMA ${s}`);
    await admin.end();
    const pool = new pg.Pool({ connectionString: live.url, max: 4, options: `-c search_path=${s}` });
    cleanups.push(() => pool.end());
    return fromPg(pool);
  };
  const pjsDb = async () => {
    const s = schema();
    const admin = postgres(live.url, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE SCHEMA ${s}`);
    await admin.end();
    const sql = postgres(live.url, { max: 4, onnotice: () => {}, connection: { search_path: s } });
    cleanups.push(() => sql.end());
    return fromPostgresJs(sql);
  };
  adapterContract('pg Pool / Neon Pool (fromPg), real Postgres', pgDb);
  adapterContract('postgres-js (fromPostgresJs), real Postgres', pjsDb);
  // The whole store contract through postgres-js: its own type mapping (jsonb, timestamptz, arrays) on every query.
  runStoreContract('postgres (postgres-js via fromPostgresJs)', async () => {
    const db = await pjsDb();
    for (const m of MIGRATIONS) for (const st of statements(m.sql)) await db.query(st);
    return postgresStore({ query: db.query });
  });
}
