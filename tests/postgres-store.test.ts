import { PGlite } from '@electric-sql/pglite';
import { afterEach, expect, it } from 'vitest';
import { MIGRATIONS, postgresStore } from '../src/postgres';
import { createBilling } from '../src/core/billing';
import { sign } from './helpers/sign';
import { loadFixture, subscriptionEvent } from './helpers/fixtures';
import { runStoreContract } from './helpers/store-contract';

// Every database a test opens is closed after it, so instances do not pile up across the file.
const open: PGlite[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

async function freshDb() {
  const db = new PGlite();
  open.push(db);
  for (const m of MIGRATIONS) await db.exec(m.sql);
  return db;
}

runStoreContract('postgres (PGlite)', async () => {
  const db = await freshDb();
  return postgresStore({ query: (text, params) => db.query(text, params) as any });
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

it('accepts a raw payload containing a NUL character (jsonb rejects \\u0000)', async () => {
  const db = await freshDb();
  const store = postgresStore({ query: (t, p) => db.query(t, p) as any });
  const s = {
    subscriptionId: 'sub_nul', customerId: 'ctm_1', userId: 'user_1', status: 'active' as const, priceIds: ['p'],
    currentPeriodEnd: null, scheduledChange: null, canceledAt: null, pastDueSince: null,
    lastEventAt: '2026-10-10T00:00:00.000Z', raw: { custom_data: 'a\u0000b', 'k\u0000': 1, back: 'x\\u0000y' },
  };
  expect(await store.upsertSubscription(s)).toEqual({ applied: true });
  expect(((await store.getSubscription('sub_nul'))!.raw as any).custom_data).toBe('ab');
});

it("never stores another app's customer: customer.* is acked 200 as ignored, 0 rows in paddle_customers", async () => {
  const db = await freshDb();
  const now = new Date('2026-10-15T12:00:00Z');
  const billing = createBilling({
    environment: 'sandbox', webhookSecret: 'sec', entitlements: {}, owns: { priceIds: ['pri_only_ours'] },
    store: postgresStore({ query: (t, p) => db.query(t, p) as any }), now: () => now, log: () => {},
  });
  const ts = Math.floor(now.getTime() / 1000);
  for (const [i, eventType] of ['customer.created', 'customer.updated'].entries()) {
    const body = JSON.stringify({ ...loadFixture('customer.created'), event_id: `evt_ctm_${i}`, event_type: eventType });
    const res = await billing.handleWebhook(new Request('https://x/', { method: 'POST', headers: { 'paddle-signature': sign(body, 'sec', ts) }, body }));
    expect(res.status).toBe(200);
  }
  expect((await db.query('SELECT * FROM paddle_customers')).rows).toEqual([]);
  const evs = (await db.query('SELECT event_id, status, reason FROM paddle_events ORDER BY event_id')).rows;
  expect(evs).toEqual([
    { event_id: 'evt_ctm_0', status: 'ignored', reason: 'unknown_event' },
    { event_id: 'evt_ctm_1', status: 'ignored', reason: 'unknown_event' },
  ]);
});

it('reads a row an older version wrote through postgres-js (JSON text stored as a jsonb string) as its value', async () => {
  // Before v0.9.0, postgres-js JSON-encoded the kit's JSON text again: price_ids held the *string* '["pri_pro"]'.
  const db = await freshDb();
  await db.query(`INSERT INTO paddle_subscriptions (subscription_id, customer_id, user_id, status, price_ids, current_period_end, scheduled_change,
      canceled_at, past_due_since, last_event_at, raw, updated_at)
    VALUES ('sub_old', 'ctm_1', 'u1', 'active', to_jsonb('["pri_pro"]'::text), now(), to_jsonb('{"action":"cancel"}'::text), NULL, NULL, now(), to_jsonb('{"id":"sub_old"}'::text), now())`);
  const store = postgresStore({ query: (t, p) => db.query(t, p) as any });
  const s = await store.getSubscription('sub_old');
  expect(s?.priceIds).toEqual(['pri_pro']);
  expect(s?.scheduledChange).toEqual({ action: 'cancel' });
  expect(s?.raw).toEqual({ id: 'sub_old' });
});
