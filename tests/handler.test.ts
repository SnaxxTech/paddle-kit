import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebhookHandler } from '../src/core/handler';
import { memoryStore } from '../src/memory';
import type { LogEntry, Store } from '../src/core/types';
import { sign } from './helpers/sign';
import { loadFixture, subscriptionEvent } from './helpers/fixtures';

const SECRET = 'pdl_ntfset_test';
const NOW = new Date('2026-10-15T12:00:00Z');
const nowSec = Math.floor(NOW.getTime() / 1000);

function post(body: string, header: string | null = sign(body, SECRET, nowSec)) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (header) headers.set('paddle-signature', header);
  return new Request('https://app.test/api/paddle', { method: 'POST', headers, body });
}

describe('webhook handler', () => {
  let store: Store;
  let logs: LogEntry[];
  let handle: (r: Request) => Promise<Response>;
  beforeEach(() => {
    store = memoryStore();
    logs = [];
    handle = createWebhookHandler({ store, secret: SECRET, toleranceSeconds: 5, log: (e) => logs.push(e), now: () => NOW });
  });

  it('stores a real subscription.created and acks 200', async () => {
    const raw = loadFixture('subscription.created');
    const res = await handle(post(JSON.stringify(raw)));
    expect(res.status).toBe(200);
    expect((await store.getSubscription(raw.data.id))?.userId).toBe('user_1');
    expect((await store.health(NOW)).lastEventAt).toBe(NOW.toISOString());
  });

  it('returns 405 for non-POST', async () => {
    expect((await handle(new Request('https://app.test/api/paddle'))).status).toBe(405);
  });

  it('acks a duplicate without reprocessing', async () => {
    const body = JSON.stringify(subscriptionEvent({ eventId: 'evt_dup' }));
    await handle(post(body));
    const spy = vi.spyOn(store, 'upsertSubscription');
    const res = await handle(post(body));
    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it('converges on the newest state when events arrive out of order and twice', async () => {
    const created = JSON.stringify(subscriptionEvent({ eventId: 'evt_c', occurredAt: '2026-10-15T10:00:00Z', data: { status: 'active' } }));
    const updated = JSON.stringify(subscriptionEvent({ eventId: 'evt_u', eventType: 'subscription.updated', occurredAt: '2026-10-15T11:00:00Z', data: { status: 'paused' } }));
    for (const b of [updated, created, updated, created]) expect((await handle(post(b))).status).toBe(200);
    const id = loadFixture('subscription.created').data.id;
    expect((await store.getSubscription(id))?.status).toBe('paused');
    expect(logs).toContainEqual(expect.objectContaining({ reason: 'out_of_order', eventId: 'evt_c' }));
  });

  it('stores a subscription without userId and surfaces it', async () => {
    const body = JSON.stringify(subscriptionEvent({ eventId: 'evt_nouser', data: { custom_data: null } }));
    expect((await handle(post(body))).status).toBe(200);
    expect((await store.health(NOW)).unlinkedLast24h).toBe(1);
    expect(logs).toContainEqual(expect.objectContaining({ reason: 'no_user_id' }));
  });

  it('starts and keeps the past_due clock', async () => {
    const id = loadFixture('subscription.created').data.id;
    await handle(post(JSON.stringify(subscriptionEvent({ eventId: 'e1', eventType: 'subscription.past_due', occurredAt: '2026-10-10T00:00:00Z', data: { status: 'past_due' } }))));
    await handle(post(JSON.stringify(subscriptionEvent({ eventId: 'e2', eventType: 'subscription.updated', occurredAt: '2026-10-12T00:00:00Z', data: { status: 'past_due' } }))));
    expect((await store.getSubscription(id))?.pastDueSince).toBe('2026-10-10T00:00:00Z');
  });

  it('ignores unknown event types with 200', async () => {
    const body = JSON.stringify({ event_id: 'evt_p', event_type: 'payout.paid', occurred_at: '2026-10-15T00:00:00Z', data: {} });
    expect((await handle(post(body))).status).toBe(200);
  });

  describe('drill (spec §8): each failure gives the right status, reason and health change', () => {
    const body = JSON.stringify(subscriptionEvent({ eventId: 'evt_drill' }));
    it.each([
      ['wrong secret', () => post(body, sign(body, 'pdl_ntfset_rotated', nowSec)), 401, 'signature_mismatch'],
      ['tampered body', () => post(body.replace('user_1', 'user_2'), sign(body, SECRET, nowSec)), 401, 'signature_mismatch'],
      ['10-minute-old timestamp', () => post(body, sign(body, SECRET, nowSec - 600)), 401, 'stale_timestamp'],
      ['missing header', () => post(body, null), 400, 'bad_signature_header'],
      ['empty body', () => post('', sign('', SECRET, nowSec)), 400, 'missing_body'],
      ['signed but not JSON', () => post('not json', sign('not json', SECRET, nowSec)), 400, 'bad_json'],
      ['signed but malformed payload', () => post('{"event_id":"x"}', sign('{"event_id":"x"}', SECRET, nowSec)), 400, 'bad_payload'],
    ] as const)('%s', async (_n, make, status, reason) => {
      const res = await handle(make());
      expect(res.status).toBe(status);
      expect(logs).toContainEqual(expect.objectContaining({ reason }));
      const h = await store.health(NOW);
      expect(h.lastFailureReason).toBe(reason);
      expect(h.failedLast24h).toBe(1);
    });

    it('store failure → 500, event marked failed, retry succeeds', async () => {
      const real = store.upsertSubscription.bind(store);
      const spy = vi.spyOn(store, 'upsertSubscription').mockRejectedValueOnce(new Error('connection reset'));
      expect((await handle(post(body))).status).toBe(500);
      expect((await store.health(NOW)).lastFailureReason).toBe('store_error');
      spy.mockImplementation(real);
      expect((await handle(post(body))).status).toBe(200);
      expect(await store.getSubscription(loadFixture('subscription.created').data.id)).not.toBeNull();
    });

    it('total store outage → 500 and a log line, no throw', async () => {
      const dead = new Proxy(store, { get: () => async () => { throw new Error('down'); } }) as Store;
      const h = createWebhookHandler({ store: dead, secret: SECRET, toleranceSeconds: 5, log: (e) => logs.push(e), now: () => NOW });
      expect((await h(post(body))).status).toBe(500);
      expect(logs).toContainEqual(expect.objectContaining({ level: 'error', reason: 'store_error' }));
    });

    it('never logs the body, header or secret', async () => {
      await handle(post(body, sign(body, 'wrong', nowSec)));
      const text = JSON.stringify(logs);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('user_1');
      expect(text).not.toContain('h1=');
    });
  });
});
