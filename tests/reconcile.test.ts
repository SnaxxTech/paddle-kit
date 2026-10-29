import { describe, expect, it } from 'vitest';
import { createBilling, type BillingConfig } from '../src/core/billing';
import type { FetchLike } from '../src/core/paddle-api';
import { memoryStore } from '../src/memory';
import { reconcile } from '../src/reconcile';
import { sign } from './helpers/sign';
import { loadFixture } from './helpers/fixtures';

// The Paddle API returns subscriptions in the same snake_case shape as a webhook's `data`.
const apiSub = (o: Record<string, unknown> = {}) => ({ ...loadFixture('subscription.created').data, ...o });
const SUB = apiSub();
const UPDATED_AT = SUB.updated_at as string;

function fakeApi(pages: unknown[][], o: { next?: (page: number) => string } = {}) {
  const calls: Array<{ url: string; auth: string }> = [];
  const fetch: FetchLike = async (url, init) => {
    expect(init.headers['Paddle-Version']).toBe('1');
    calls.push({ url, auth: init.headers.Authorization! });
    const page = calls.length - 1;
    const last = page >= pages.length - 1;
    const next = o.next?.(page) ?? `https://sandbox-api.paddle.com/subscriptions?after=p${page}`;
    return { ok: true, status: 200, json: async () => ({ data: pages[page] ?? [], meta: { pagination: { has_more: !last, next: last ? null : next } } }) };
  };
  return { fetch, calls };
}
const billing = (o: Partial<BillingConfig> = {}) =>
  createBilling({ environment: 'sandbox', webhookSecret: 'sec', store: memoryStore(), entitlements: { [SUB.items[0].price.id]: ['pro'] }, log: () => {}, ...o });

describe('reconcile', () => {
  it('fills a missing subscription so access is correct after missed webhooks', async () => {
    const b = billing();
    const api = fakeApi([[SUB]]);
    expect(await reconcile(b, { apiKey: 'pdl_sdbx_apikey_x', fetch: api.fetch })).toEqual({ scanned: 1, applied: 1, notOurs: 0, invalid: 0 });
    expect(await b.hasAccess('user_1', 'pro')).toBe(true);
    expect(api.calls[0]).toEqual({ url: 'https://sandbox-api.paddle.com/subscriptions?per_page=200', auth: 'Bearer pdl_sdbx_apikey_x' });
  });

  it('a reconciled row deep-equals the webhook row for the same subscription, apart from lastEventAt', async () => {
    const viaWebhook = billing();
    const event = { ...loadFixture('subscription.created'), data: SUB };
    const body = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000);
    expect((await viaWebhook.handleWebhook(new Request('https://x/', { method: 'POST', headers: { 'paddle-signature': sign(body, 'sec', ts) }, body }))).status).toBe(200);
    const viaReconcile = billing();
    await reconcile(viaReconcile, { apiKey: 'pdl_sdbx_apikey_x', fetch: fakeApi([[SUB]]).fetch });
    const a = (await viaWebhook.store.getSubscription(SUB.id))!;
    const r = (await viaReconcile.store.getSubscription(SUB.id))!;
    expect(r.lastEventAt).toBe(UPDATED_AT); // the snapshot's own time: a webhook that occurred later still wins
    expect({ ...r, lastEventAt: null }).toEqual({ ...a, lastEventAt: null });
    expect(r.raw).toEqual(SUB); // snake_case, as Paddle sends it
  });

  it('follows pagination, and never follows a link to another host (the API key would leak)', async () => {
    const two = fakeApi([[SUB], [apiSub({ id: 'sub_2' })]]);
    expect(await reconcile(billing(), { apiKey: 'pdl_sdbx_apikey_x', fetch: two.fetch })).toMatchObject({ scanned: 2, applied: 2 });
    expect(two.calls.map((c) => c.url)).toEqual(['https://sandbox-api.paddle.com/subscriptions?per_page=200', 'https://sandbox-api.paddle.com/subscriptions?after=p0']);
    const evil = fakeApi([[SUB], [SUB]], { next: () => 'https://evil.example/subscriptions?after=x' });
    await expect(reconcile(billing(), { apiKey: 'pdl_sdbx_apikey_x', fetch: evil.fetch })).rejects.toThrow(/another host/);
    expect(evil.calls).toHaveLength(1);
  });

  it('uses the live API for a production billing', async () => {
    const api = fakeApi([[]]);
    await reconcile(billing({ environment: 'production', allowProductionInDev: true }), { apiKey: 'pdl_live_apikey_x', fetch: api.fetch });
    expect(api.calls[0]!.url).toBe('https://api.paddle.com/subscriptions?per_page=200');
  });

  it('applies the webhook checks: an unknown status is skipped as invalid, a control character drops the userId', async () => {
    const b = billing();
    const api = fakeApi([[apiSub({ id: 'sub_bad', status: 'exploded' }), apiSub({ id: 'sub_ctl', custom_data: { userId: 'user\u0000_1' } })]]);
    expect(await reconcile(b, { apiKey: 'pdl_sdbx_apikey_x', fetch: api.fetch })).toEqual({ scanned: 2, applied: 1, notOurs: 0, invalid: 1 });
    expect(await b.store.getSubscription('sub_bad')).toBeNull();
    expect((await b.store.getSubscription('sub_ctl'))?.userId).toBeNull();
  });

  it('never overwrites newer webhook state with an older API snapshot', async () => {
    const b = billing();
    await b.store.upsertSubscription({
      subscriptionId: SUB.id, customerId: SUB.customer_id, userId: 'user_1', status: 'canceled', priceIds: [],
      currentPeriodEnd: null, scheduledChange: null, canceledAt: '2026-10-15T00:00:00.000Z', pastDueSince: null,
      lastEventAt: '2030-01-01T00:00:00.000Z', raw: {},
    });
    expect(await reconcile(b, { apiKey: 'pdl_sdbx_apikey_x', fetch: fakeApi([[SUB]]).fetch })).toEqual({ scanned: 1, applied: 0, notOurs: 0, invalid: 0 });
    expect(await b.hasAccess('user_1', 'pro')).toBe(false);
  });

  it('rejects a live key against a sandbox billing before any request', async () => {
    const api = fakeApi([[]]);
    await expect(reconcile(billing(), { apiKey: 'pdl_live_apikey_x', fetch: api.fetch })).rejects.toThrow(/environment/);
    expect(api.calls).toHaveLength(0);
  });

  it('a failing API call names the status, never the key', async () => {
    const fetch: FetchLike = async () => ({ ok: false, status: 403, json: async () => ({ error: { code: 'forbidden', detail: 'key pdl_sdbx_apikey_x is not allowed' } }) });
    const err = await reconcile(billing(), { apiKey: 'pdl_sdbx_apikey_x', fetch }).catch((e: Error) => e);
    expect(String(err)).toMatch(/403/);
    expect(String(err)).not.toContain('pdl_sdbx_apikey_x');
  });

  it('an owns resolver: resolved ids filter like static owns; a failed lookup throws before any subscription is read', async () => {
    const ours = billing({ owns: { resolve: async () => ({ priceIds: [SUB.items[0].price.id] }) } });
    const other = apiSub({ id: 'sub_other', items: [{ ...SUB.items[0], price: { ...SUB.items[0].price, id: 'pri_someone_else' } }] });
    expect(await reconcile(ours, { apiKey: 'pdl_sdbx_apikey_x', fetch: fakeApi([[SUB, other]]).fetch })).toEqual({ scanned: 2, applied: 1, notOurs: 1, invalid: 0 });

    // A resolver may return a predicate too: the same filter.
    const byPredicate = billing({ owns: { resolve: async () => ({ items }) => items.some((i) => i.priceId === SUB.items[0].price.id) } });
    expect(await reconcile(byPredicate, { apiKey: 'pdl_sdbx_apikey_x', fetch: fakeApi([[SUB, other]]).fetch })).toEqual({ scanned: 2, applied: 1, notOurs: 1, invalid: 0 });

    const down = billing({ owns: { resolve: async () => { throw new Error('paddle down'); } } });
    const api = fakeApi([[SUB]]);
    await expect(reconcile(down, { apiKey: 'pdl_sdbx_apikey_x', fetch: api.fetch })).rejects.toThrow('paddle down');
    expect(api.calls).toHaveLength(0);
    expect(await down.store.getSubscription(SUB.id)).toBeNull();
  });
});
