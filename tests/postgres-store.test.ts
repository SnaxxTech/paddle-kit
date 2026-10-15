import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { MIGRATIONS, postgresStore } from '../src/postgres';
import { createBilling } from '../src/core/billing';
import { sign } from './helpers/sign';
import { subscriptionEvent } from './helpers/fixtures';
import { runStoreContract } from './helpers/store-contract';

async function freshDb() {
  const db = new PGlite();
  for (const m of MIGRATIONS) await db.exec(m.sql);
  return db;
}

runStoreContract('postgres (PGlite)', async () => {
  const db = await freshDb();
  return postgresStore({ query: (text, params) => db.query(text, params) as any });
});

it('migrations/001_init.sql is byte-identical to MIGRATIONS[0]', () => {
  expect(readFileSync(new URL('../migrations/001_init.sql', import.meta.url), 'utf8')).toBe(MIGRATIONS[0]!.sql);
});

it('migrations are additive: only CREATE statements on paddle_ tables', () => {
  for (const m of MIGRATIONS) {
    expect(m.sql).not.toMatch(/\b(DROP|ALTER|TRUNCATE|DELETE)\b/i);
    for (const t of m.sql.matchAll(/CREATE (?:TABLE|INDEX)(?: IF NOT EXISTS)? (\w+)/gi)) expect(t[1]).toMatch(/^paddle_/);
  }
});

it('out-of-order + duplicate deliveries converge in real Postgres', async () => {
  const db = await freshDb();
  const now = new Date('2026-10-15T12:00:00Z');
  const billing = createBilling({
    environment: 'sandbox', webhookSecret: 'sec', entitlements: {},
    store: postgresStore({ query: (t, p) => db.query(t, p) as any }), now: () => now, log: () => {},
  });
  const ts = Math.floor(now.getTime() / 1000);
  const send = (b: unknown) => {
    const body = JSON.stringify(b);
    return billing.handleWebhook(new Request('https://x/', { method: 'POST', headers: { 'paddle-signature': sign(body, 'sec', ts) }, body }));
  };
  const created = subscriptionEvent({ eventId: 'c', occurredAt: '2026-10-15T10:00:00Z', data: { status: 'active' } });
  const updated = subscriptionEvent({ eventId: 'u', eventType: 'subscription.updated', occurredAt: '2026-10-15T11:00:00Z', data: { status: 'paused' } });
  for (const e of [updated, created, updated, created]) expect((await send(e)).status).toBe(200);
  const rows = (await db.query<{ status: string }>('SELECT status FROM paddle_subscriptions')).rows;
  expect(rows).toEqual([{ status: 'paused' }]);
  const evs = (await db.query<{ event_id: string; status: string }>('SELECT event_id, status FROM paddle_events ORDER BY event_id')).rows;
  expect(evs).toEqual([{ event_id: 'c', status: 'stale' }, { event_id: 'u', status: 'processed' }]);
});
