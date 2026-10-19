import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebhookHandler, MAX_WEBHOOK_BODY_BYTES } from '../src/core/handler';
import { memoryStore } from '../src/memory';
import type { Adjustment, HookContext, LogEntry, Store, Transaction } from '../src/core/types';
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

  it('keeps the earliest past_due start when events arrive out of order', async () => {
    const id = loadFixture('subscription.created').data.id;
    await handle(post(JSON.stringify(subscriptionEvent({ eventId: 'o1', eventType: 'subscription.updated', occurredAt: '2026-10-12T00:00:00Z', data: { status: 'past_due' } }))));
    await handle(post(JSON.stringify(subscriptionEvent({ eventId: 'o2', eventType: 'subscription.past_due', occurredAt: '2026-10-10T00:00:00Z', data: { status: 'past_due' } }))));
    const sub = await store.getSubscription(id);
    expect(sub?.pastDueSince).toBe('2026-10-10T00:00:00Z');
    expect(sub?.status).toBe('past_due');
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
      expect((await store.health(NOW)).failedLast24h).toBe(1);
      spy.mockImplementation(real);
      expect((await handle(post(body))).status).toBe(200);
      expect(await store.getSubscription(loadFixture('subscription.created').data.id)).not.toBeNull();
    });

    it('recordEvent failure → 500 and health shows store_error', async () => {
      vi.spyOn(store, 'recordEvent').mockRejectedValueOnce(new Error('events table down'));
      expect((await handle(post(body))).status).toBe(500);
      const h = await store.health(NOW);
      expect(h.lastFailureReason).toBe('store_error');
      expect(h.failedLast24h).toBe(1);
    });

    it('unreadable request body → 400 missing_body, no throw', async () => {
      const req = new Request('https://app.test/api/paddle', {
        method: 'POST',
        body: new ReadableStream({ start(c) { c.error(new Error('abort')); } }),
        duplex: 'half',
      } as any);
      const res = await handle(req);
      expect(res.status).toBe(400);
      expect((await store.health(NOW)).lastFailureReason).toBe('missing_body');
    });

    describe('body cap', () => {
      const CHUNK = 64 * 1024;
      // An endless unsigned body, counting the bytes the handler pulls from it.
      function flood(headers: Record<string, string> = {}) {
        const pulled = { bytes: 0 };
        const chunk = new Uint8Array(CHUNK).fill(32);
        const body = new ReadableStream({ pull(c) { if (pulled.bytes >= 64 * 1024 * 1024) return c.close(); pulled.bytes += CHUNK; c.enqueue(chunk); } });
        return { pulled, req: new Request('https://app.test/api/paddle', { method: 'POST', headers, body, duplex: 'half' } as any) };
      }

      it.each([
        ['no content-length', {}],
        ['a content-length that lies', { 'content-length': '100' }],
      ])('64 MB unsigned stream with %s → 413 body_too_large, read stops at the cap', async (_n, headers) => {
        const { pulled, req } = flood(headers);
        const res = await handle(req);
        expect(res.status).toBe(413);
        expect(await res.json()).toEqual({ error: 'body_too_large' });
        expect(pulled.bytes).toBeLessThanOrEqual(MAX_WEBHOOK_BODY_BYTES + 2 * CHUNK); // the chunk that crossed + one buffered
        const h = await store.health(NOW);
        expect(h.lastFailureReason).toBe('body_too_large');
        expect(h.failedLast24h).toBe(1);
      });

      it('content-length over the cap → 413 before reading', async () => {
        const { pulled, req } = flood({ 'content-length': String(MAX_WEBHOOK_BODY_BYTES + 1) });
        expect((await handle(req)).status).toBe(413);
        expect(pulled.bytes).toBeLessThanOrEqual(CHUNK);
      });

      it('a signed body exactly at the cap, streamed with a 2-byte character split across chunks, is verified and processed', async () => {
        const event = subscriptionEvent({ eventId: 'evt_big' });
        const shell = JSON.stringify({ ...event, padding: '' });
        const big = JSON.stringify({ ...event, padding: 'x'.repeat(MAX_WEBHOOK_BODY_BYTES - new TextEncoder().encode(shell).length - 2) + 'é' });
        const bytes = new TextEncoder().encode(big);
        expect(bytes.length).toBe(MAX_WEBHOOK_BODY_BYTES);
        const cut = bytes.length - 3; // between the two bytes of 'é' (it is followed by '"}')
        const body = new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, cut)); c.enqueue(bytes.slice(cut)); c.close(); } });
        const req = new Request('https://app.test/api/paddle', { method: 'POST', headers: { 'paddle-signature': sign(big, SECRET, nowSec) }, body, duplex: 'half' } as any);
        expect((await handle(req)).status).toBe(200);
        expect(await store.getSubscription(event.data.id)).not.toBeNull();
      });

      it('maxBodyBytes lowers the cap', async () => {
        const h = createWebhookHandler({ store, secret: SECRET, toleranceSeconds: 5, log: (e) => logs.push(e), now: () => NOW, maxBodyBytes: 256_000 });
        const big = JSON.stringify({ ...subscriptionEvent({ eventId: 'evt_300k' }), padding: 'x'.repeat(300_000) });
        expect((await h(post(big))).status).toBe(413);
        expect((await h(post(JSON.stringify(subscriptionEvent({ eventId: 'evt_small' }))))).status).toBe(200);
      });
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

  describe('transaction and adjustment hooks', () => {
    const txBody = () => JSON.stringify(loadFixture('transaction.completed'));
    const adjBody = () => JSON.stringify(loadFixture('adjustment.created'));
    function withHooks() {
      const onTransaction = vi.fn<(tx: Transaction, ctx: HookContext) => Promise<void> | void>();
      const onAdjustment = vi.fn<(adj: Adjustment, ctx: HookContext) => Promise<void> | void>();
      const h = createWebhookHandler({ store, secret: SECRET, toleranceSeconds: 5, log: (e) => logs.push(e), now: () => NOW, onTransaction, onAdjustment });
      return { h, onTransaction, onAdjustment };
    }

    it('calls onTransaction once with the parsed transaction and a context', async () => {
      const { h, onTransaction } = withHooks();
      expect((await h(post(txBody()))).status).toBe(200);
      expect(onTransaction).toHaveBeenCalledTimes(1);
      const [tx, ctx] = onTransaction.mock.calls[0]!;
      expect(tx.transactionId).toBe('txn_01hv8wptq8987qeep44cyrewp9');
      expect(tx.items[0]).toEqual({ priceId: 'pri_01gsz8x8sawmvhz1pv30nge1ke', productId: 'pro_01gsz4t5hdjse780zja8vvr7jg', quantity: 10 });
      expect(ctx.eventType).toBe('transaction.completed');
      expect(ctx.eventId).toBe(loadFixture('transaction.completed').event_id);
      expect(ctx.store).toBe(store);
    });

    it('does not call the hook again for a duplicate delivery', async () => {
      const { h, onTransaction } = withHooks();
      await h(post(txBody()));
      const res = await h(post(txBody()));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true, duplicate: true });
      expect(onTransaction).toHaveBeenCalledTimes(1);
    });

    it('throwing hook → 500 hook_error, event failed and visible in health; retry runs it once more and processes', async () => {
      const { h, onTransaction } = withHooks();
      onTransaction.mockRejectedValueOnce(new Error('db exploded: secret-detail'));
      const res = await h(post(txBody()));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'hook_error' });
      expect(logs).toContainEqual(expect.objectContaining({ level: 'error', reason: 'hook_error', eventType: 'transaction.completed' }));
      expect(JSON.stringify(logs)).not.toContain('secret-detail');
      const health = await store.health(NOW);
      expect(health.lastFailureReason).toBe('hook_error');
      expect(health.failedLast24h).toBe(1);

      onTransaction.mockResolvedValueOnce(undefined);
      expect((await h(post(txBody()))).status).toBe(200);
      expect(onTransaction).toHaveBeenCalledTimes(2);
      // now processed: a third delivery is a duplicate and must not run the hook again
      expect(await (await h(post(txBody()))).json()).toEqual({ received: true, duplicate: true });
      expect(onTransaction).toHaveBeenCalledTimes(2);
    });

    it('a synchronous throw is a hook_error too', async () => {
      const { h, onTransaction } = withHooks();
      onTransaction.mockImplementationOnce(() => { throw new Error('sync boom'); });
      const res = await h(post(txBody()));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'hook_error' });
    });

    it('a store failure while a hook is configured stays store_error', async () => {
      const { h, onTransaction } = withHooks();
      vi.spyOn(store, 'markEvent').mockRejectedValueOnce(new Error('connection reset'));
      const res = await h(post(txBody()));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'store_error' });
      expect(onTransaction).toHaveBeenCalledTimes(1);
    });

    it('without hooks a transaction.completed is processed (v0.2 behaviour: no state change)', async () => {
      const raw = loadFixture('transaction.completed');
      const spies = [vi.spyOn(store, 'upsertSubscription'), vi.spyOn(store, 'upsertCustomer')];
      const markEvent = vi.spyOn(store, 'markEvent');
      const res = await handle(post(txBody()));
      expect(res.status).toBe(200);
      expect(markEvent).toHaveBeenCalledWith(raw.event_id, 'processed', null);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(await store.getSubscription(raw.data.subscription_id)).toBeNull();
      expect((await store.health(NOW)).failedLast24h).toBe(0);
      expect(logs).toEqual([]);
      // processed rows dedupe
      expect(await (await handle(post(txBody()))).json()).toEqual({ received: true, duplicate: true });
    });

    it('transaction.paid is record-only: processed, hook not called; paid + completed for the same txn runs the hook once', async () => {
      const { h, onTransaction } = withHooks();
      const paid = loadFixture('transaction.completed');
      paid.event_id = 'evt_paid_1';
      paid.event_type = 'transaction.paid';
      expect((await h(post(JSON.stringify(paid)))).status).toBe(200);
      expect(onTransaction).not.toHaveBeenCalled();
      expect((await store.health(NOW)).failedLast24h).toBe(0);
      expect((await h(post(txBody()))).status).toBe(200);
      expect(onTransaction).toHaveBeenCalledTimes(1);
      expect(onTransaction.mock.calls[0]![1].eventType).toBe('transaction.completed');
      expect(onTransaction.mock.calls[0]![0].transactionId).toBe(paid.data.id);
    });

    it('calls onAdjustment with the refund data', async () => {
      const { h, onAdjustment, onTransaction } = withHooks();
      expect((await h(post(adjBody()))).status).toBe(200);
      expect(onTransaction).not.toHaveBeenCalled();
      expect(onAdjustment).toHaveBeenCalledTimes(1);
      const [adj, ctx] = onAdjustment.mock.calls[0]!;
      expect(adj).toMatchObject({ action: 'refund', status: 'pending_approval', transactionId: 'txn_01hvcc93znj3mpqt1tenkjb04y', total: '100', currency: 'USD' });
      expect(ctx.eventType).toBe('adjustment.created');
      // duplicate
      await h(post(adjBody()));
      expect(onAdjustment).toHaveBeenCalledTimes(1);
    });

    it('a throwing onAdjustment is a hook_error', async () => {
      const { h, onAdjustment } = withHooks();
      onAdjustment.mockRejectedValueOnce(new Error('nope'));
      const res = await h(post(adjBody()));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'hook_error' });
      expect((await store.health(NOW)).lastFailureReason).toBe('hook_error');
    });

    it('adjustment events without a hook are processed (record-only)', async () => {
      expect((await handle(post(adjBody()))).status).toBe(200);
      expect(logs).toEqual([]);
    });

    it('hooks never run for a bad signature', async () => {
      const { h, onTransaction } = withHooks();
      expect((await h(post(txBody(), sign(txBody(), 'wrong', nowSec)))).status).toBe(401);
      expect(onTransaction).not.toHaveBeenCalled();
    });
  });
});
