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
