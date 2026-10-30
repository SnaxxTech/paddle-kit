import { describe, expect, it, vi } from 'vitest';
import { PaddleError } from '../src/core/paddle-api';
import { PriceError, findPrice, findPriceMap, formatPrice, getPrice, type FetchLike } from '../src/price';

const KEY = 'pdl_sdbx_apikey_SECRET_VALUE';
const ID = 'pri_01abc';
// The shape of GET /prices/{id} (Paddle API v1), trimmed to the fields the kit reads plus some it ignores.
const entity = (over: Record<string, unknown> = {}) => ({
  id: ID,
  product_id: 'pro_01x',
  name: 'Team (monthly)',
  description: 'Team plan',
  billing_cycle: { interval: 'month', frequency: 1 },
  unit_price: { amount: '1500', currency_code: 'USD' },
  status: 'active',
  ...over,
});
const answer = (status: number, body: unknown): FetchLike => async () => ({ ok: status < 300, status, json: async () => body });

async function failure(run: Promise<unknown>): Promise<PriceError> {
  const error = await run.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(PriceError);
  expect(error).toBeInstanceOf(PaddleError);
  expect((error as Error).message).not.toContain(KEY);
  return error as PriceError;
}

describe('getPrice', () => {
  it('reads a recurring price with the pinned version and the bearer key, from the environment base URL', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; method: string }> = [];
    const fetch: FetchLike = async (url, init) => {
      seen.push({ url, headers: init.headers, method: init.method });
      return { ok: true, status: 200, json: async () => ({ data: entity(), meta: { request_id: 'r' } }) };
    };
    expect(await getPrice(ID, { apiKey: KEY, environment: 'sandbox', fetch })).toEqual({
      id: ID,
      amount: '1500',
      currency: 'USD',
      interval: { interval: 'month', frequency: 1 },
      name: 'Team (monthly)',
      status: 'active',
    });
    expect(seen).toEqual([
      { url: `https://sandbox-api.paddle.com/prices/${ID}`, method: 'GET', headers: expect.objectContaining({ Authorization: `Bearer ${KEY}`, 'Paddle-Version': '1' }) },
    ]);

    const live: string[] = [];
    await getPrice(ID, { apiKey: 'pdl_live_k', environment: 'production', fetch: async (url) => (live.push(url), { ok: true, status: 200, json: async () => ({ data: entity() }) }) });
    expect(live).toEqual([`https://api.paddle.com/prices/${ID}`]);
  });

  it('a one-time price has interval null; a missing name is null; an archived price still reads', async () => {
    const p = await getPrice(ID, { apiKey: KEY, environment: 'sandbox', fetch: answer(200, { data: entity({ billing_cycle: null, name: null, status: 'archived' }) }) });
    expect(p).toMatchObject({ interval: null, name: null, status: 'archived' });
  });

  it('401 and 403 are unauthorized, 404 is not_found, other statuses are http; the key never reaches the message', async () => {
    const planted = { error: { code: 'forbidden', detail: `bad key ${KEY}` } };
    for (const [status, code] of [[401, 'unauthorized'], [403, 'unauthorized'], [404, 'not_found'], [429, 'http'], [500, 'http']] as const) {
      const e = await failure(getPrice(ID, { apiKey: KEY, environment: 'sandbox', fetch: answer(status, planted) }));
      expect([e.code, e.status]).toEqual([code, status]);
    }
  });

  it('a key for the other environment, or an unknown key, is refused before any request', async () => {
    const fetch = vi.fn(answer(200, { data: entity() }));
    expect((await failure(getPrice(ID, { apiKey: KEY, environment: 'production', fetch }))).code).toBe('unauthorized');
    expect((await failure(getPrice(ID, { apiKey: 'pdl_live_k', environment: 'sandbox', fetch }))).code).toBe('unauthorized');
    expect((await failure(getPrice(ID, { apiKey: 'sk_other', environment: 'sandbox', fetch }))).code).toBe('unauthorized');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('an id that is not pri_… is refused before any request (no path tricks, no list endpoint)', async () => {
    const fetch = vi.fn(answer(200, { data: entity() }));
    for (const bad of ['', 'pro_01', 'pri_01/../../customers', 'pri_01?x=1']) {
      expect((await failure(getPrice(bad, { apiKey: KEY, environment: 'sandbox', fetch }))).code).toBe('not_found');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a fetch that rejects is a network error whose text is not echoed', async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError(`connect ECONNREFUSED with ${KEY}`);
    };
    const e = await failure(getPrice(ID, { apiKey: KEY, environment: 'sandbox', fetch }));
    expect(e.code).toBe('network');
    expect(e.message).not.toContain('ECONNREFUSED');
  });

  it('times out after timeoutMs and aborts the request', async () => {
    let signal: AbortSignal | undefined;
    const fetch: FetchLike = (_url, init) => {
      signal = init.signal;
      return new Promise(() => {}); // never answers
    };
    const e = await failure(getPrice(ID, { apiKey: KEY, environment: 'sandbox', fetch, timeoutMs: 20 }));
    expect(e.code).toBe('timeout');
    expect(signal?.aborted).toBe(true);
  });

  it('a 2xx answer that is not a price is malformed', async () => {
    const bad: unknown[] = [
      {},
      { data: [] },
      { data: [entity()] },
      { data: entity({ id: 5 }) },
      { data: entity({ unit_price: { amount: 1500, currency_code: 'USD' } }) },
      { data: entity({ unit_price: { amount: '15.00', currency_code: 'USD' } }) },
      { data: entity({ unit_price: { amount: '1500', currency_code: 'usd' } }) },
      { data: entity({ unit_price: undefined }) },
      { data: entity({ status: 'deleted' }) },
      { data: entity({ name: 7 }) },
      { data: entity({ billing_cycle: { interval: 'fortnight', frequency: 1 } }) },
      { data: entity({ billing_cycle: { interval: 'month', frequency: 0 } }) },
    ];
    for (const body of bad) {
      expect((await failure(getPrice(ID, { apiKey: KEY, environment: 'sandbox', fetch: answer(200, body) }))).code).toBe('malformed');
    }
    const notJson: FetchLike = async () => ({ ok: true, status: 200, json: async () => JSON.parse('<html>') });
    expect((await failure(getPrice(ID, { apiKey: KEY, environment: 'sandbox', fetch: notJson }))).code).toBe('malformed');
  });
});

describe('findPrice and findPriceMap (by the catalog CLI labels, since v0.7.0)', () => {
  const product = (app: string, status = 'active') => ({ id: `pro_${app}`, status, custom_data: { paddle_kit: app } });
  // GET /prices?include=product: each price carries its product.
  const labelled = (id: string, label: string, o: Record<string, unknown> = {}) =>
    entity({ id, custom_data: { paddle_kit_price: label }, product: product('leakscan'), billing_cycle: label.endsWith('-once') ? null : { interval: 'month', frequency: 1 }, ...o });
  // Pages of a listing, following meta.pagination.next like Paddle does.
  function listing(pages: unknown[][]) {
    const urls: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      urls.push(url);
      expect(init.headers['Paddle-Version']).toBe('1');
      const page = urls.length - 1;
      const more = page < pages.length - 1;
      return { ok: true, status: 200, json: async () => ({ data: pages[page] ?? [], meta: { pagination: { has_more: more, next: more ? `https://sandbox-api.paddle.com/prices?after=p${page}` : null } } }) };
    };
    return { fetch, urls };
  }
  const opts = (fetch: FetchLike) => ({ apiKey: KEY, environment: 'sandbox' as const, fetch });

  it('finds the one active price with the label on the app\'s product, across pages, and returns it like getPrice', async () => {
    const api = listing([
      [labelled('pri_other_app', 'scan-once', { product: product('offday') }), labelled('pri_unmarked', 'x', { custom_data: null })],
      [labelled('pri_scan', 'scan-once', { unit_price: { amount: '1500', currency_code: 'USD' }, name: 'Full Scan' })],
    ]);
    expect(await findPrice({ app: 'leakscan', key: 'scan', cycle: 'once' }, opts(api.fetch))).toEqual({
      id: 'pri_scan', amount: '1500', currency: 'USD', interval: null, name: 'Full Scan', status: 'active',
    });
    expect(api.urls).toEqual(['https://sandbox-api.paddle.com/prices?status=active&include=product&per_page=200', 'https://sandbox-api.paddle.com/prices?after=p0']);
  });

  it('no match is not_found; two active prices with the label are ambiguous (both ids named); the key never reaches a message', async () => {
    const none = await failure(findPrice({ app: 'leakscan', key: 'scan', cycle: 'once' }, opts(listing([[labelled('pri_m', 'scan-monthly')]]).fetch)));
    expect([none.code, none.message]).toEqual(['not_found', 'price "scan-once" of app "leakscan": no active price has this label (run paddle-kit-catalog)']);
    const two = await failure(findPrice({ app: 'leakscan', key: 'scan', cycle: 'once' }, opts(listing([[labelled('pri_a', 'scan-once'), labelled('pri_b', 'scan-once')]]).fetch)));
    expect(two.code).toBe('ambiguous');
    expect(two.message).toContain('pri_a, pri_b');
  });

  it('ignores archived prices and prices of an archived product', async () => {
    const api = listing([[labelled('pri_old', 'scan-once', { status: 'archived' }), labelled('pri_gone', 'scan-once', { product: product('leakscan', 'archived') }), labelled('pri_live', 'scan-once')]]);
    expect((await findPrice({ app: 'leakscan', key: 'scan', cycle: 'once' }, opts(api.fetch))).id).toBe('pri_live');
  });

  it('a found entity that is not a price is malformed; HTTP errors, timeouts and a wrong key map like getPrice', async () => {
    expect((await failure(findPrice({ app: 'leakscan', key: 'scan', cycle: 'once' }, opts(listing([[labelled('pri_x', 'scan-once', { unit_price: null })]]).fetch)))).code).toBe('malformed');
    const planted = { error: { code: 'forbidden', detail: `bad key ${KEY}` } };
    expect((await failure(findPrice({ app: 'a', key: 'k', cycle: 'once' }, opts(answer(403, planted))))).code).toBe('unauthorized');
    expect((await failure(findPriceMap('a', opts(answer(500, planted))))).code).toBe('http');
    expect((await failure(findPriceMap('a', { ...opts(() => new Promise(() => {})), timeoutMs: 20 }))).code).toBe('timeout');
    const fetch = vi.fn(answer(200, { data: [] }));
    expect((await failure(findPriceMap('a', { apiKey: KEY, environment: 'production', fetch }))).code).toBe('unauthorized');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a pagination link to another host is refused, and the key goes nowhere', async () => {
    const urls: string[] = [];
    const evil: FetchLike = async (url) => (urls.push(url), { ok: true, status: 200, json: async () => ({ data: [], meta: { pagination: { has_more: true, next: 'https://evil.example/prices' } } }) });
    expect((await failure(findPriceMap('a', opts(evil)))).code).toBe('malformed');
    expect(urls.every((u) => u.startsWith('https://sandbox-api.paddle.com/'))).toBe(true);
  });

  it('findPriceMap builds the PADDLE_PRICES map the catalog CLI writes: one-time-only keys flat, other keys by cycle', async () => {
    const api = listing([[labelled('pri_scan', 'scan-once'), labelled('pri_tm', 'team-monthly'), labelled('pri_ty', 'team-yearly'), labelled('pri_mo', 'mixed-once'), labelled('pri_mm', 'mixed-monthly')]]);
    expect(await findPriceMap('leakscan', opts(api.fetch))).toEqual({ scan: 'pri_scan', team: { monthly: 'pri_tm', yearly: 'pri_ty' }, mixed: { once: 'pri_mo', monthly: 'pri_mm' } });
    expect(await findPriceMap('nobody', opts(listing([[labelled('pri_scan', 'scan-once')]]).fetch))).toEqual({});
    expect((await failure(findPriceMap('leakscan', opts(listing([[labelled('pri_a', 'scan-once'), labelled('pri_b', 'scan-once')]]).fetch)))).code).toBe('ambiguous');
  });
});

describe('formatPrice', () => {
  it('drops cents only on whole amounts', () => {
    expect(formatPrice('1500', 'USD')).toBe('$15');
    expect(formatPrice(999, 'USD')).toBe('$9.99');
    expect(formatPrice('990', 'USD')).toBe('$9.90');
    expect(formatPrice('0', 'USD')).toBe('$0');
    expect(formatPrice('123456', 'USD')).toBe('$1,234.56');
  });
  it('does not divide zero-decimal currencies by 100', () => {
    expect(formatPrice('1500', 'JPY')).toBe('¥1,500');
    expect(formatPrice('9900', 'KRW')).toBe('₩9,900');
  });
  it('uses the locale', () => {
    expect(formatPrice('1499', 'EUR', 'de-DE')).toBe('14,99 €');
    expect(formatPrice('1500', 'EUR', 'de-DE')).toBe('15 €');
  });
  it('throws on an amount or currency that is not one', () => {
    expect(() => formatPrice('ten', 'USD')).toThrow(RangeError);
    expect(() => formatPrice('100', 'NOPE')).toThrow(RangeError);
  });
});
