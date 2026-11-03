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
  it('reads only adjustment events since `since` (across pages), never the whole list, and replays each adjustment\'s latest status once', async () => {
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
    expect(seen.sort()).toEqual(['adj_a:approved', 'adj_b:approved']);
    expect(out.adjustments).toMatchObject({ scanned: 2, applied: 2, invalid: 0 });
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
