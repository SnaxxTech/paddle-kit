import { describe, expect, it } from 'vitest';
import { createBilling } from '../src/core';
import type { FetchLike } from '../src/core/paddle-api';
import { memoryStore } from '../src/memory';
import { reconcilePayments } from '../src/reconcile';

// Incremental adjustment reads (since v0.8.6): GET /adjustments has no date filter, so every recovery run read the
// whole list (up to 200 pages). Within Paddle's 90-day event retention, recovery reads only the adjustment events
// since its checkpoint; older windows (a first run, a long outage) still read the full list.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function paddle(o: { adjustments?: any[]; events?: any[][] }) {
  const calls: string[] = [];
  const page = (data: any[], next?: string) => ({ ok: true, status: 200, json: async () => ({ data, meta: { pagination: { has_more: !!next, next: next ?? null } } }) });
  const fetch: FetchLike = async (url) => {
    calls.push(url.replace('https://sandbox-api.paddle.com', ''));
    const u = new URL(url);
    if (u.pathname === '/transactions') return page([]);
    if (u.pathname.startsWith('/transactions/')) return { ok: false, status: 404, json: async () => ({ error: { code: 'not_found' } }) };
    if (u.pathname === '/adjustments') return page(o.adjustments ?? []);
    if (u.pathname === '/events') {
      const pages = o.events ?? [[]];
      const i = Number(u.searchParams.get('after')?.replace('cursor_', '') ?? 0);
      return page(pages[i] ?? [], i + 1 < pages.length ? `https://sandbox-api.paddle.com/events?after=cursor_${i + 1}` : undefined);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetch, calls };
}

const adj = (id: string, status: string, at: string) => ({
  id, transaction_id: `txn_${id}`, subscription_id: null, customer_id: 'ctm_1', action: 'refund', type: 'full', status,
  currency_code: 'USD', totals: { total: '100', subtotal: '100' }, created_at: at, updated_at: at, items: [],
});
const event = (n: number, a: ReturnType<typeof adj>, type = 'adjustment.updated') => ({ event_id: `evt_${String(n).padStart(3, '0')}`, event_type: type, occurred_at: a.updated_at, data: a });

function setup() {
  const seen: string[] = [];
  const billing = createBilling({
    environment: 'sandbox', webhookSecret: 's', store: memoryStore(), entitlements: {}, owns: () => true,
    onAdjustment: (a) => { seen.push(`${a.adjustmentId}:${a.status}`); },
  });
  return { billing, seen };
}

describe('reconcilePayments: adjustments since a recent checkpoint come from the event stream', () => {
  // Since v0.8.7 events are read page by page (resumable, bounded memory): the newest status per adjustment wins within
  // a page; a status on an earlier page replays too (statuses only move forward; hooks run at least once anyway).
  it('reads only adjustment events since `since` (across pages), never the whole list, and replays each status once', async () => {
    const t0 = Date.now() - 3 * HOUR;
    const iso = (h: number) => new Date(t0 + h * HOUR).toISOString();
    const p = paddle({
      adjustments: [adj('adj_old', 'approved', iso(-1000))], // must not be read
      events: [
        [event(1, adj('adj_a', 'pending_approval', iso(1)), 'adjustment.created'), event(2, adj('adj_b', 'approved', iso(1)), 'adjustment.created')],
        [event(3, adj('adj_a', 'approved', iso(2)))],
      ],
    });
    const { billing, seen } = setup();
    const out = await reconcilePayments(billing, { apiKey: 'pdl_sdbx_k', since: new Date(t0), fetch: p.fetch });
    expect(p.calls.some((c) => c.startsWith('/adjustments'))).toBe(false);
    const ev = p.calls.filter((c) => c.startsWith('/events'));
    expect(ev[0]).toBe(`/events?event_type=adjustment.created,adjustment.updated&from=${encodeURIComponent(new Date(t0).toISOString())}&order_by=id%5BASC%5D&per_page=200`);
    expect(ev).toHaveLength(2);
    expect(seen.sort()).toEqual(['adj_a:approved', 'adj_a:pending_approval', 'adj_b:approved']);
    expect(out.adjustments).toMatchObject({ scanned: 3, applied: 3, invalid: 0 });
  });

  it('an event whose adjustment has no valid time is counted invalid, never dropped', async () => {
    const bad = { ...adj('adj_x', 'approved', 'not-a-date') };
    const p = paddle({ events: [[{ event_id: 'evt_001', event_type: 'adjustment.updated', occurred_at: 'nope', data: bad }]] });
    const out = await reconcilePayments(setup().billing, { apiKey: 'pdl_sdbx_k', since: new Date(Date.now() - HOUR), fetch: p.fetch });
    expect(out.adjustments).toMatchObject({ scanned: 1, invalid: 1, applied: 0 });
  });

  it('a window older than the event stream keeps (89+ days, a first run) reads the full adjustment list as before', async () => {
    const p = paddle({ adjustments: [adj('adj_old', 'approved', new Date(Date.now() - 100 * DAY).toISOString())] });
    const { billing, seen } = setup();
    await reconcilePayments(billing, { apiKey: 'pdl_sdbx_k', since: new Date(Date.now() - 120 * DAY), fetch: p.fetch });
    expect(p.calls.some((c) => c.startsWith('/adjustments'))).toBe(true);
    expect(p.calls.some((c) => c.startsWith('/events'))).toBe(false);
    expect(seen).toEqual(['adj_old:approved']);
  });
});

// Subscriptions too (second follow-up): reconcile listed every subscription on each run.
import { recoverBilling, reconcile } from '../src/reconcile';
import { loadFixture } from './helpers/fixtures';

describe('reconcile: subscriptions since a recent `since` come from the event stream', () => {
  const sub = (id: string, status: string, at: string) => ({ ...loadFixture('subscription.created').data, id, status, updated_at: at, custom_data: { userId: `u_${id}` } });
  function api(o: { subs?: any[]; events?: any[] }) {
    const calls: string[] = [];
    const page = (data: any[]) => ({ ok: true, status: 200, json: async () => ({ data, meta: { pagination: { has_more: false, next: null } } }) });
    const fetch: FetchLike = async (url) => {
      const u = new URL(url);
      calls.push(u.pathname + (u.pathname === '/events' ? `?${u.searchParams.get('event_type')}` : ''));
      if (u.pathname === '/subscriptions') return page(o.subs ?? []);
      if (u.pathname === '/events') return page((u.searchParams.get('event_type') ?? '').startsWith('subscription.') ? (o.events ?? []) : []);
      return page([]);
    };
    return { fetch, calls };
  }
  const billingFor = () => createBilling({ environment: 'sandbox', webhookSecret: 's', store: memoryStore(), entitlements: {}, owns: () => true });

  it('with a recent `since`, reads subscription events (newest state per subscription), never the whole list', async () => {
    const at = (h: number) => new Date(Date.now() - 3 * HOUR + h * HOUR).toISOString();
    const p = api({
      subs: [sub('sub_never', 'active', at(-5000))],
      events: [
        { event_id: 'evt_1', event_type: 'subscription.created', occurred_at: at(1), data: sub('sub_a', 'trialing', at(1)) },
        { event_id: 'evt_2', event_type: 'subscription.updated', occurred_at: at(2), data: sub('sub_a', 'active', at(2)) },
        { event_id: 'evt_3', event_type: 'subscription.canceled', occurred_at: at(2), data: sub('sub_b', 'canceled', at(2)) },
      ],
    });
    const b = billingFor();
    const out = await reconcile(b, { apiKey: 'pdl_sdbx_k', since: new Date(Date.now() - 3 * HOUR), fetch: p.fetch });
    expect(p.calls.some((c) => c === '/subscriptions')).toBe(false);
    expect(p.calls).toContain('/events?subscription.activated,subscription.canceled,subscription.created,subscription.imported,subscription.past_due,subscription.paused,subscription.resumed,subscription.trialing,subscription.updated');
    expect(out).toMatchObject({ scanned: 2, applied: 2 });
    expect((await b.store.getSubscription('sub_a'))?.status).toBe('active');
    expect(await b.store.getSubscription('sub_never')).toBeNull();
  });

  it('without `since`, or with a window older than 89 days, lists every subscription as before', async () => {
    for (const since of [undefined, new Date(Date.now() - 120 * DAY)]) {
      const p = api({ subs: [sub('sub_x', 'active', new Date().toISOString())] });
      await reconcile(billingFor(), { apiKey: 'pdl_sdbx_k', since, fetch: p.fetch });
      expect(p.calls.filter((c) => c.startsWith('/events?subscription'))).toEqual([]);
      expect(p.calls).toContain('/subscriptions');
    }
  });

  it('recoverBilling passes its window: a second run after a recent checkpoint reads no subscription list', async () => {
    const p = api({ subs: [sub('sub_x', 'active', new Date().toISOString())] });
    const b = billingFor();
    expect((await recoverBilling(b, { apiKey: 'pdl_sdbx_k', fetch: p.fetch })).status).toBe('done'); // first run: full history
    expect(p.calls.filter((c) => c === '/subscriptions')).toHaveLength(1);
    p.calls.length = 0;
    expect((await recoverBilling(b, { apiKey: 'pdl_sdbx_k', fetch: p.fetch })).status).toBe('done');
    expect(p.calls.filter((c) => c === '/subscriptions')).toHaveLength(0);
    expect(p.calls.some((c) => c.startsWith('/events?subscription.'))).toBe(true);
  });
});

describe('recoverBilling resumes an interrupted run (third review)', () => {
  const sub = (id: string) => ({ ...loadFixture('subscription.created').data, id, status: 'active', updated_at: '2026-10-01T00:00:00Z', custom_data: { userId: `u_${id}` } });
  // Four pages of subscriptions; each page takes 40 ms, so a 100 ms run gets through about two of them.
  function backlog() {
    const calls: string[] = [];
    const page = (data: any[], next: string | null) => ({ ok: true, status: 200, json: async () => ({ data, meta: { pagination: { has_more: !!next, next } } }) });
    const fetch: FetchLike = async (url) => {
      const u = new URL(url);
      calls.push(u.pathname + u.search);
      await new Promise((r) => setTimeout(r, 40));
      if (u.pathname === '/subscriptions') {
        const n = Number(u.searchParams.get('after')?.replace('sub_p', '') ?? 0);
        return page([sub(`sub_${n}`)], n < 3 ? `https://sandbox-api.paddle.com/subscriptions?per_page=200&after=sub_p${n + 1}` : null);
      }
      return page([], null);
    };
    return { fetch, calls };
  }

  it('a run that times out saves its page; the next run continues there, inside the same window, and checkpoints at its start', async () => {
    const b = createBilling({ environment: 'sandbox', webhookSecret: 's', store: memoryStore(), entitlements: {}, owns: () => true });
    const p = backlog();
    const t1 = new Date(Date.now() - 60_000);
    const first = await recoverBilling(b, { apiKey: 'pdl_sdbx_k', fetch: p.fetch, timeoutMs: 100, now: () => t1 });
    expect(first).toMatchObject({ status: 'failed', reason: 'timeout' });
    const firstPages = p.calls.filter((c) => c.startsWith('/subscriptions')).length;
    expect(firstPages).toBeGreaterThan(0);
    expect(firstPages).toBeLessThan(4);
    await new Promise((r) => setTimeout(r, 60)); // let the aborted run settle
    p.calls.length = 0;
    const second = await recoverBilling(b, { apiKey: 'pdl_sdbx_k', fetch: p.fetch, timeoutMs: 10_000 });
    expect(second.status).toBe('done');
    const subs = p.calls.filter((c) => c.startsWith('/subscriptions'));
    expect(subs[0]).toContain('after=sub_p'); // resumed, not page 1 again
    expect(subs.length).toBeLessThanOrEqual(4 - firstPages + 1);
    for (const c of p.calls.filter((c) => c.startsWith('/transactions'))) expect(c).toContain(`updated_at%5BLT%5D=${encodeURIComponent(t1.toISOString())}`);
    const state = await b.store.recovery!.getRecovery('sandbox');
    expect(state?.checkpointAt).toBe(t1.toISOString());
    for (const id of ['sub_0', 'sub_1', 'sub_2', 'sub_3']) expect(await b.store.getSubscription(id)).not.toBeNull();
  });

  it('progress saved more than a day ago is still continued (a daily schedule, or a backlog over several days)', async () => {
    const b = createBilling({ environment: 'sandbox', webhookSecret: 's', store: memoryStore(), entitlements: {}, owns: () => true });
    const p = backlog();
    const t1 = new Date(Date.now() - 25 * 3_600_000);
    expect(await recoverBilling(b, { apiKey: 'pdl_sdbx_k', fetch: p.fetch, timeoutMs: 100, now: () => t1 })).toMatchObject({ status: 'failed' });
    await new Promise((r) => setTimeout(r, 60));
    p.calls.length = 0;
    expect((await recoverBilling(b, { apiKey: 'pdl_sdbx_k', fetch: p.fetch, timeoutMs: 10_000 })).status).toBe('done');
    expect(p.calls.find((c) => c.startsWith('/subscriptions'))).toContain('after=sub_p');
    expect((await b.store.recovery!.getRecovery('sandbox'))?.checkpointAt).toBe(t1.toISOString());
  });
});
