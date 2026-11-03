import { describe, expect, it } from 'vitest';
import { createBilling } from '../src/core/billing';
import { memoryStore } from '../src/memory';
import { recoverBilling } from '../src/reconcile';
import { paddleClient, type FetchLike } from '../src/core/paddle-api';
import { diagnose } from '../src/doctor/cli';

const at = new Date('2026-10-30T12:00:00Z');
const tx = { id: 'txn_lost', status: 'completed', subscription_id: null, updated_at: at.toISOString(), items: [{ price: { id: 'pri_ours' }, quantity: 1 }] };
const sub = { id: 'sub_lost', customer_id: 'ctm_1', custom_data: { userId: 'org_1' }, status: 'active', items: [{ price: { id: 'pri_ours' } }], updated_at: at.toISOString() };
const page = (data: unknown[]) => ({ ok: true, status: 200, json: async () => ({ data, meta: { pagination: { has_more: false } } }) });
const fixture = (onTransaction?: () => void) => createBilling({ environment: 'sandbox', webhookSecret: 'audit_secret', store: memoryStore(),
  owns: { priceIds: ['pri_ours'] }, entitlements: { pri_ours: ['pro'] }, log: () => {}, now: () => at, onTransaction });
const api: FetchLike = async url => page(new URL(url).pathname === '/subscriptions' ? [sub] : new URL(url).pathname === '/transactions' ? [tx] : []);
const options = { apiKey: 'pdl_sdbx_fake', fetch: api, now: () => at };

describe('durable billing recovery', () => {
  it('repairs lost state, is idempotent, and retains its checkpoint across new runner calls', async () => {
    let grants = 0;
    const b = fixture(() => { grants++; });
    expect(await b.hasAccess('org_1', 'pro')).toBe(false);
    expect(await recoverBilling(b, options)).toMatchObject({ status: 'done', since: new Date(0).toISOString() });
    expect(await b.hasAccess('org_1', 'pro')).toBe(true);
    const first = await b.store.recovery!.getRecovery('sandbox');
    const later = new Date('2026-11-20T12:00:00Z');
    const result = await recoverBilling(b, { ...options, now: () => later });
    expect(result).toMatchObject({ status: 'done', since: '2026-10-30T11:00:00.000Z' });
    expect(grants).toBe(1);
    expect(first?.checkpointAt).toBe(at.toISOString());
  });

  it('keeps the checkpoint on partial failure, then self-heals when the hook recovers', async () => {
    let fail = true;
    const b = fixture(() => { if (fail) throw new Error('injected failure'); });
    expect(await recoverBilling(b, options)).toMatchObject({ status: 'failed', reason: 'incomplete', payments: { transactions: { failed: 1 } } });
    expect(await b.store.recovery!.getRecovery('sandbox')).toMatchObject({ status: 'failed', checkpointAt: null });
    fail = false;
    expect(await recoverBilling(b, options)).toMatchObject({ status: 'done', since: new Date(0).toISOString() });
    expect(await b.store.recovery!.getRecovery('sandbox')).toMatchObject({ status: 'succeeded', checkpointAt: at.toISOString() });
  });

  it('replays an original abandoned event through its original ledger ID', async () => {
    const b = fixture();
    await b.store.recordEvent({ eventId: 'evt_abandoned', eventType: 'subscription.created', occurredAt: sub.updated_at, receivedAt: '2026-10-01T00:00:00Z' });
    const fetch: FetchLike = async (url, init) => url.includes('/events?')
      ? page([{ event_id: 'evt_abandoned', event_type: 'subscription.created', occurred_at: sub.updated_at, data: sub }])
      : api(url, init);
    expect(await recoverBilling(b, { ...options, fetch })).toMatchObject({ status: 'done', events: { applied: 1, failed: 0 } });
    expect(await b.store.health(at)).toMatchObject({ oldestPendingAt: null, unresolvedFailed: 0 });
  });

  it('crashed jobs are reclaimed, overlapping jobs do not run, and a timeout stays failed', async () => {
    const b = fixture();
    const r = b.store.recovery!;
    await r.claimRecovery({ name: 'sandbox', runId: 'old', startedAt: at.toISOString(), leaseUntil: new Date(at.getTime() + 60000).toISOString() });
    expect(await recoverBilling(b, options)).toEqual({ status: 'busy' });
    expect(await recoverBilling(b, { ...options, now: () => new Date(at.getTime() + 60001) })).toMatchObject({ status: 'done' });
    const stalled: FetchLike = async () => new Promise(() => {});
    expect(await recoverBilling(b, { ...options, fetch: stalled, timeoutMs: 10 })).toEqual({ status: 'failed', reason: 'timeout' });
    expect(await r.getRecovery('sandbox')).toMatchObject({ status: 'failed', checkpointAt: new Date(at.getTime() + 60001).toISOString() });
  });

  it('cannot call an exhausted or malformed pagination result a complete repair', async () => {
    const endlessly: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ data: [], meta: { pagination: { has_more: true, next: 'https://sandbox-api.paddle.com/next' } } }) });
    await expect(paddleClient('https://sandbox-api.paddle.com', 'fake', endlessly, []).list('/first', 2)).rejects.toThrow('incomplete');
    expect(await recoverBilling(fixture(), { ...options, fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) })).toMatchObject({ status: 'failed' });
  });

  it('doctor keeps unresolved failures and crashed events red regardless of the latest failure reason', async () => {
    const b = fixture();
    await b.store.recordEvent({ eventId: 'evt_failure', eventType: 'transaction.completed', occurredAt: at.toISOString(), receivedAt: '2026-10-01T00:00:00Z' });
    await b.store.markEvent('evt_failure', 'failed', 'hook_error');
    await b.store.recordFailure('bad_json', at);
    expect(diagnose(200, JSON.stringify(await b.store.health(at)), { now: at.getTime() }).ok).toBe(false);
    const stuck = fixture();
    await stuck.store.recordEvent({ eventId: 'evt_stuck', eventType: 'subscription.created', occurredAt: at.toISOString(), receivedAt: '2026-10-01T00:00:00Z' });
    expect(diagnose(200, JSON.stringify(await stuck.store.health(at)), { now: at.getTime() }).ok).toBe(false);
  });

  it('an adjustment with an invalid timestamp is never skipped silently: recovery is incomplete and the checkpoint holds', async () => {
    const b = fixture();
    const broken = { id: 'adj_broken', transaction_id: 'txn_lost', action: 'refund', type: 'full', status: 'approved', updated_at: 'not-a-date', created_at: 'also-not' };
    const fetch: FetchLike = async (url, init) => new URL(url).pathname === '/adjustments' ? page([broken]) : api(url, init);
    const result = await recoverBilling(b, { ...options, fetch });
    expect(result).toMatchObject({ status: 'failed', reason: 'incomplete', payments: { adjustments: { invalid: 1 } } });
    expect(await b.store.recovery!.getRecovery('sandbox')).toMatchObject({ status: 'failed', checkpointAt: null });
  });
});

