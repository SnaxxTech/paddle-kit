// Concurrency and load on a REAL Postgres server (PGlite runs one transaction at a time, so it cannot show races).
// Server: PADDLE_KIT_PG_URL=postgres://… or the `embedded-postgres` devDependency; client: `pg`.
// Without both, every test here is skipped and a loud SKIP line is printed. Run alone: npm run test:pg
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createBilling } from '../src/core/billing';
import { MIGRATIONS, postgresStore, type SqlQuery } from '../src/postgres';
import { sign } from './helpers/sign';
import { loadFixture, subscriptionEvent } from './helpers/fixtures';

type Pool = { query: SqlQuery; end(): Promise<void> };
type PgModule = { default: { Pool: new (o: Record<string, unknown>) => Pool } };

async function connect(): Promise<{ url: string; stop: () => Promise<void> } | { skip: string }> {
  const pg = await import('pg' as string).catch(() => null);
  if (!pg) return { skip: 'the `pg` client is not installed' };
  if (process.env.PADDLE_KIT_PG_URL) return { url: process.env.PADDLE_KIT_PG_URL, stop: async () => {} };
  const mod = await import('embedded-postgres' as string).catch(() => null);
  if (!mod) return { skip: 'no PADDLE_KIT_PG_URL and `embedded-postgres` is not installed' };
  const dir = mkdtempSync(join(tmpdir(), 'paddle-kit-pg-'));
  const port = 54_000 + Math.floor(Math.random() * 1000);
  const server = new mod.default({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => {} });
  await server.initialise();
  await server.start();
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    stop: async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const db = await connect();
if ('skip' in db) {
  // process.stderr, not console: vitest drops console output of a file whose tests are all skipped.
  process.stderr.write(`\n######## SKIP: real-Postgres concurrency suite NOT RUN (${db.skip}). Concurrency is UNVERIFIED. ########\n\n`);
}
const live = 'url' in db ? db : null;
const { Pool } = live ? ((await import('pg' as string)) as PgModule).default : ({} as PgModule['default']);

const SECRET = 'pdl_ntfset_test';
const NOW = new Date('2026-10-15T12:00:00Z');
const ts = Math.floor(NOW.getTime() / 1000);
const pools: Pool[] = [];
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
  if (live) await live.stop();
});

/** A fresh schema per test, migrated with the kit's own MIGRATIONS, behind a pool of real connections. */
async function freshPool(max = 20): Promise<Pool> {
  const schema = `pk_${Math.random().toString(36).slice(2, 10)}`;
  const admin = new Pool({ connectionString: live!.url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = new Pool({ connectionString: live!.url, max, options: `-c search_path=${schema}` });
  pools.push(pool);
  for (const m of MIGRATIONS) await pool.query(m.sql);
  return pool;
}

function billingOn(pool: Pool, o: Parameters<typeof createBilling>[0] extends infer C ? Partial<C> : never = {}) {
  const billing = createBilling({
    environment: 'sandbox', webhookSecret: SECRET, entitlements: {}, now: () => NOW, log: () => {},
    store: postgresStore({ query: (t, p) => pool.query(t, p) }), ...o,
  });
  const send = (event: unknown) => {
    const body = JSON.stringify(event);
    return billing.handleWebhook(new Request('https://app.test/', { method: 'POST', headers: { 'paddle-signature': sign(body, SECRET, ts) }, body }));
  };
  return { billing, send };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shuffle = <T>(xs: T[]): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

describe.skipIf(!live)('real Postgres: concurrency', () => {
  let pool: Pool;
  beforeEach(async () => { pool = await freshPool(); });

  it('N=50 parallel deliveries of one event: each hook runs once, one ledger row', async () => {
    let txCalls = 0;
    const { send } = billingOn(pool, { onTransaction: async () => { txCalls++; await sleep(50); } });
    const event = loadFixture('transaction.completed');
    const res = await Promise.all(Array.from({ length: 50 }, () => send(event)));
    const bodies = await Promise.all(res.map((r) => r.json() as Promise<Record<string, unknown>>));
    const processed = res.filter((r, i) => r.status === 200 && !bodies[i]!.duplicate).length;
    const tally = { processed, duplicate: bodies.filter((b) => b.duplicate).length, inProgress: res.filter((r) => r.status === 409).length, other: res.filter((r) => r.status !== 200 && r.status !== 409).length };
    console.log(`[pg] N=50 same event: ${JSON.stringify(tally)} sum=${tally.processed + tally.duplicate + tally.inProgress + tally.other} hookCalls=${txCalls}`);
    expect(tally.processed + tally.duplicate + tally.inProgress + tally.other).toBe(50);
    expect(txCalls).toBe(1);
    expect(processed).toBe(1);
    expect(tally.other).toBe(0);
    const { rows } = await pool.query(`SELECT status, reason FROM paddle_events WHERE event_id = $1`, [event.event_id]);
    expect(rows).toEqual([{ status: 'processed', reason: null }]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM paddle_event_claims`)).rows[0]!.n).toBe(0);
  });

  it('N=50 parallel deliveries of one adjustment: onAdjustment runs once', async () => {
    let calls = 0;
    const { send } = billingOn(pool, { onAdjustment: async () => { calls++; await sleep(50); } });
    await Promise.all(Array.from({ length: 50 }, () => send(loadFixture('adjustment.created'))));
    expect(calls).toBe(1);
  });

  it('parallel subscription.updated events in shuffled order converge on the newest state (5 rounds)', async () => {
    const statuses = ['active', 'past_due', 'paused', 'active', 'canceled'] as const;
    for (let round = 0; round < 5; round++) {
      const p = await freshPool();
      const { send } = billingOn(p);
      const events = Array.from({ length: 40 }, (_, i) =>
        subscriptionEvent({
          eventId: `evt_${round}_${i}`, eventType: 'subscription.updated',
          occurredAt: new Date(Date.UTC(2026, 9, 15, 10, 0, i)).toISOString(),
          data: { status: statuses[i % statuses.length], custom_data: { userId: `user_${i}` } },
        }),
      );
      const res = await Promise.all(shuffle(events).map(send));
      expect(res.every((r) => r.status === 200)).toBe(true);
      const newest = events.at(-1)!;
      const { rows } = await p.query(`SELECT status, user_id, last_event_at FROM paddle_subscriptions`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe(newest.data.status);
      expect(rows[0]!.user_id).toBe('user_39');
      expect(new Date(rows[0]!.last_event_at as string).toISOString()).toBe(new Date(newest.occurred_at).toISOString());
      const ledger = await p.query(`SELECT status, count(*)::int AS n FROM paddle_events GROUP BY status ORDER BY status`);
      const n = Object.fromEntries(ledger.rows.map((r) => [r.status, r.n]));
      expect((n.processed ?? 0) + (n.stale ?? 0)).toBe(40);
      expect(n.processed).toBeGreaterThanOrEqual(1);
    }
  });

  it('parallel redeliveries of transaction.completed (with a flaky hook) fire onTransaction at least once and never corrupt the ledger', async () => {
    let calls = 0;
    const { send } = billingOn(pool, {
      onTransaction: async () => { calls++; await sleep(5); if (Math.random() < 0.5) throw new Error('flaky'); },
    });
    const base = loadFixture('transaction.completed');
    // 10 distinct events (e.g. transaction.completed redelivered under fresh ids) for one transaction, each delivered 5×
    const events = Array.from({ length: 10 }, (_, i) => ({ ...base, event_id: `evt_txn_${i}` }));
    let pending = events;
    for (let attempt = 0; attempt < 30 && pending.length > 0; attempt++) {
      const res = await Promise.all(shuffle(pending.flatMap((e) => [e, e, e, e, e])).map(async (e) => ({ e, r: await send(e) })));
      for (const { r } of res) expect([200, 409, 500]).toContain(r.status);
      const { rows } = await pool.query(`SELECT event_id FROM paddle_events WHERE status = 'processed'`);
      const done = new Set(rows.map((r) => r.event_id));
      pending = pending.filter((e) => !done.has(e.event_id));
    }
    expect(pending).toEqual([]);
    expect(calls).toBeGreaterThanOrEqual(10);
    const ledger = await pool.query(`SELECT event_id, status FROM paddle_events ORDER BY event_id`);
    expect(ledger.rows).toEqual(events.map((e) => ({ event_id: e.event_id, status: 'processed' })).sort((a, b) => a.event_id.localeCompare(b.event_id)));
    expect((await pool.query(`SELECT count(*)::int AS n FROM paddle_event_claims`)).rows[0]!.n).toBe(0);
    expect((await pool.query(`SELECT transaction_id, owned FROM paddle_transactions`)).rows).toEqual([{ transaction_id: base.data.id, owned: true }]);
  });

  it('load: 1,000 events through handleWebhook — p95 latency and error count, samples reconciled against sent', async () => {
    let txCalls = 0;
    let adjCalls = 0;
    const { send, billing } = billingOn(pool, { onTransaction: () => { txCalls++; }, onAdjustment: () => { adjCalls++; } });
    const txBase = loadFixture('transaction.completed');
    const adjBase = loadFixture('adjustment.created');
    const unique: unknown[] = [
      ...Array.from({ length: 400 }, (_, i) => subscriptionEvent({
        eventId: `evt_s_${i}`, eventType: 'subscription.updated', occurredAt: new Date(Date.UTC(2026, 9, 15, 0, 0, i)).toISOString(),
        data: { id: `sub_${i % 100}`, status: 'active', custom_data: { userId: `u_${i % 100}` } },
      })),
      ...Array.from({ length: 300 }, (_, i) => ({ ...txBase, event_id: `evt_t_${i}`, data: { ...txBase.data, id: `txn_${i}` } })),
      ...Array.from({ length: 100 }, (_, i) => ({ ...adjBase, event_id: `evt_a_${i}`, data: { ...adjBase.data, id: `adj_${i}`, transaction_id: `txn_${i}` } })),
    ];
    const deliveries = shuffle([...unique, ...shuffle(unique).slice(0, 200)]); // 800 unique + 200 duplicates
    const SENT = deliveries.length;
    expect(SENT).toBe(1000);
    const latencies: number[] = [];
    const statuses: number[] = [];
    let next = 0;
    const CONCURRENCY = 25;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (next < deliveries.length) {
        const e = deliveries[next++];
        const start = performance.now();
        const r = await send(e);
        latencies.push(performance.now() - start);
        statuses.push(r.status);
      }
    }));
    const wall = performance.now() - t0;
    const sorted = [...latencies].sort((a, b) => a - b);
    const errors = statuses.filter((s) => s !== 200 && s !== 409).length;
    const inProgress = statuses.filter((s) => s === 409).length;
    const line = { sent: SENT, samples: latencies.length, reconciled: latencies.length === SENT, errors, inProgress, concurrency: CONCURRENCY, poolMax: 20,
      p50ms: +pct(sorted, 50).toFixed(1), p95ms: +pct(sorted, 95).toFixed(1), p99ms: +pct(sorted, 99).toFixed(1), maxms: +sorted.at(-1)!.toFixed(1), wallms: Math.round(wall),
      perSec: Math.round((SENT / wall) * 1000), txCalls, adjCalls };
    console.log(`[pg] load: ${JSON.stringify(line)}`);
    expect(latencies.length).toBe(SENT);
    expect(errors).toBe(0);
    // duplicates that raced their original answered 409 and are retried by Paddle; every unique event ran its hook once at most
    expect(txCalls).toBe(300);
    expect(adjCalls).toBe(100);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM paddle_events WHERE status IN ('processed','stale')`);
    expect(rows[0]!.n).toBe(800);
    expect((await billing.health()).failedLast24h).toBe(0);
  }, 120_000);
});
