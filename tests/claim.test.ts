import { describe, expect, it } from 'vitest';
import { createWebhookHandler } from '../src/core/handler';
import { memoryStore } from '../src/memory';
import type { Store } from '../src/core/types';
import { sign } from './helpers/sign';
import { loadFixture } from './helpers/fixtures';

const SECRET = 'pdl_ntfset_test';
const NOW = new Date('2026-10-15T12:00:00Z');
const nowSec = Math.floor(NOW.getTime() / 1000);
const post = (body: string) =>
  new Request('https://app.test/api/paddle', { method: 'POST', headers: { 'paddle-signature': sign(body, SECRET, nowSec) }, body });
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('event claim (concurrent duplicate deliveries)', () => {
  it('50 parallel deliveries of one event run the hook once; the rest answer 409 in_progress', async () => {
    const store: Store = memoryStore();
    let calls = 0;
    const handle = createWebhookHandler({
      store, secret: SECRET, toleranceSeconds: 5, log: () => {}, now: () => NOW,
      onTransaction: async () => { calls++; await new Promise((r) => setTimeout(r, 50)); },
    });
    const body = JSON.stringify(loadFixture('transaction.completed'));
    const res = await Promise.all(Array.from({ length: 50 }, () => handle(post(body))));
    const bodies = await Promise.all(res.map((r) => r.json() as Promise<Record<string, unknown>>));
    expect(calls).toBe(1);
    // exactly one delivery processes; the rest raced it (409) or arrived after it finished (200 duplicate)
    expect(res.filter((r, i) => r.status === 200 && !bodies[i]!.duplicate)).toHaveLength(1);
    expect(res.filter((r, i) => r.status === 409 || bodies[i]!.duplicate)).toHaveLength(49);
    expect(res.filter((r) => r.status === 409).length).toBeGreaterThan(0);
    expect(bodies.find((_, i) => res[i]!.status === 409)).toEqual({ error: 'in_progress' });
    // in_progress is not a failure: health stays clean
    expect((await store.health(NOW)).failedLast24h).toBe(0);
    // a redelivery after the winner finished is a plain duplicate
    expect(await (await handle(post(body))).json()).toEqual({ received: true, duplicate: true });
    expect(calls).toBe(1);
  });

  it('a claim older than the lease (a crashed attempt) is taken over', async () => {
    const store = memoryStore();
    let now = NOW;
    let calls = 0;
    const handle = createWebhookHandler({
      store, secret: SECRET, toleranceSeconds: 5, log: () => {}, now: () => now, leaseSeconds: 60,
      onTransaction: () => { calls++; },
    });
    const raw = loadFixture('transaction.completed');
    // a crashed attempt: the event row is claimed ('received') and never marked
    await store.recordEvent({ eventId: raw.event_id, eventType: raw.event_type, occurredAt: raw.occurred_at, receivedAt: NOW.toISOString(), leaseExpiredBefore: new Date(NOW.getTime() - 60_000).toISOString() });
    expect((await handle(post(JSON.stringify(raw)))).status).toBe(409);
    now = new Date(NOW.getTime() + 61_000);
    const body = JSON.stringify(raw);
    const late = new Request('https://app.test/api/paddle', { method: 'POST', headers: { 'paddle-signature': sign(body, SECRET, Math.floor(now.getTime() / 1000)) }, body });
    expect((await handle(late)).status).toBe(200);
    expect(calls).toBe(1);
  });

  it('a failed event is retried at once (no lease wait)', async () => {
    const store = memoryStore();
    let fail = true;
    let calls = 0;
    const handle = createWebhookHandler({
      store, secret: SECRET, toleranceSeconds: 5, log: () => {}, now: () => NOW,
      onTransaction: () => { calls++; if (fail) throw new Error('boom'); },
    });
    const body = JSON.stringify(loadFixture('transaction.completed'));
    expect((await handle(post(body))).status).toBe(500);
    fail = false;
    expect((await handle(post(body))).status).toBe(200);
    expect(calls).toBe(2);
  });
});
