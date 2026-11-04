import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { SQLITE_MIGRATIONS, sqliteStore } from '../src/sqlite';
import { createBilling } from '../src/core/billing';
import { sign } from './helpers/sign';
import { subscriptionEvent } from './helpers/fixtures';
import { runStoreContract } from './helpers/store-contract';

function freshDb() {
  const db = new Database(':memory:');
  for (const m of SQLITE_MIGRATIONS) db.exec(m.sql);
  return db;
}

runStoreContract('sqlite (better-sqlite3)', async () => sqliteStore({ db: freshDb() }));

it('migrations are additive: only CREATE … IF NOT EXISTS on paddle_ tables', () => {
  for (const m of SQLITE_MIGRATIONS) {
    expect(m.sql).not.toMatch(/\b(DROP|ALTER|TRUNCATE|DELETE|UPDATE|INSERT)\b/i);
    for (const t of m.sql.matchAll(/CREATE (?:UNIQUE )?(?:TABLE|INDEX) IF NOT EXISTS (\w+)(?: ON (\w+))?/gi)) {
      expect(t[1]).toMatch(/^paddle_/);
      if (t[2]) expect(t[2]).toMatch(/^paddle_/);
    }
  }
});

it('running the migrations twice is harmless', () => {
  const db = freshDb();
  for (const m of SQLITE_MIGRATIONS) db.exec(m.sql);
});

it('out-of-order + duplicate deliveries converge in SQLite', async () => {
  const db = freshDb();
  const now = new Date('2026-10-15T12:00:00Z');
  const billing = createBilling({
    environment: 'sandbox', webhookSecret: 'sec', entitlements: {},
    store: sqliteStore({ db }), now: () => now, log: () => {},
  });
  const ts = Math.floor(now.getTime() / 1000);
  const send = (b: unknown) => {
    const body = JSON.stringify(b);
    return billing.handleWebhook(new Request('https://x/', { method: 'POST', headers: { 'paddle-signature': sign(body, 'sec', ts) }, body }));
  };
  const created = subscriptionEvent({ eventId: 'c', occurredAt: '2026-10-15T10:00:00Z', data: { status: 'active' } });
  const updated = subscriptionEvent({ eventId: 'u', eventType: 'subscription.updated', occurredAt: '2026-10-15T11:00:00Z', data: { status: 'paused' } });
  for (const e of [updated, created, updated, created]) expect((await send(e)).status).toBe(200);
  expect(db.prepare('SELECT status FROM paddle_subscriptions').all()).toEqual([{ status: 'paused' }]);
  expect(db.prepare('SELECT event_id, status FROM paddle_events ORDER BY event_id').all()).toEqual([
    { event_id: 'c', status: 'stale' },
    { event_id: 'u', status: 'processed' },
  ]);
});

it('a claim won just after another delivery finished sees the finished event (two processes on one file)', () => {
  // Process B reads the event as received; process A then marks it processed and releases its lease; B's claim then
  // succeeds. B must not run the hooks again (Postgres re-reads the status after its claim; SQLite must too).
  const db = freshDb();
  const a = sqliteStore({ db });
  let between: (() => void) | null = null;
  const wrapped = new Proxy(db, { get(target, key) {
    if (key !== 'prepare') return (target as any)[key].bind ? (target as any)[key].bind(target) : (target as any)[key];
    return (text: string) => {
      const stmt = target.prepare(text);
      if (!/INSERT INTO paddle_event_leases/.test(text)) return stmt;
      return new Proxy(stmt, { get(s, k) {
        if (k !== 'run') return (s as any)[k].bind ? (s as any)[k].bind(s) : (s as any)[k];
        return (...args: unknown[]) => { const hook = between; between = null; hook?.(); return s.run(...(args as [])); };
      } });
    };
  } });
  const b = sqliteStore({ db: wrapped as typeof db });
  const ev = { eventId: 'evt_race', eventType: 'subscription.updated', occurredAt: '2026-10-15T09:59:59.000Z' };
  return (async () => {
    expect(await a.recordEvent({ ...ev, receivedAt: '2026-10-15T10:00:00.000Z', leaseExpiredBefore: '2026-10-15T09:59:00.000Z', claimToken: 'A' })).toEqual({ alreadyDone: false });
    between = () => { void a.markEvent('evt_race', 'processed', null, 'A'); };
    expect(await b.recordEvent({ ...ev, receivedAt: '2026-10-15T10:00:01.000Z', leaseExpiredBefore: '2026-10-15T10:00:00.500Z', claimToken: 'B' })).toEqual({ alreadyDone: true });
  })();
});
