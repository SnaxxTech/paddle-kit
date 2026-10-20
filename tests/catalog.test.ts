import { afterEach, describe, expect, test, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CatalogError,
  EVENTS,
  readEnvFile,
  redactSecrets,
  syncCatalog,
  toPriceMap,
  validateCatalog,
  writeEnvFile,
  type Catalog,
  type FetchLike,
} from '../src/catalog/index';
import { main, parseArgs } from '../src/catalog/cli';

const KEY = 'pdl_sdbx_apikey_SECRET_VALUE';
const WH_SECRET = 'pdl_ntfset_SECRET_endpoint_key';
const TOKEN = 'test_clienttoken1234567890';
const HOOK = 'https://abc.trycloudflare.com/api/paddle';

const CATALOG: Catalog = {
  app: 'demo',
  product: { name: 'Demo', taxCategory: 'standard', description: 'A demo app' },
  prices: [
    { key: 'team25', cycle: 'monthly', name: 'Team (monthly)', amount: '1000', currency: 'USD', quantity: { min: 1, max: 1 } },
    { key: 'team25', cycle: 'yearly', name: 'Team (yearly)', amount: '10000', currency: 'USD', quantity: { min: 1, max: 1 } },
    { key: 'pack5', cycle: 'once', name: '5 codes', amount: '1499', currency: 'USD' },
  ],
};

type Call = { method: string; path: string; body: any };
type FakeOptions = { pageSize?: number; token?: string; omitSecret?: boolean; secret?: string };

// A tiny in-memory Paddle: products, prices, notification settings, client tokens.
function fakePaddle(opts: FakeOptions = {}) {
  const calls: Call[] = [];
  const products: any[] = [];
  const prices: any[] = [];
  const settings: any[] = [];
  let n = 0;
  const id = (p: string) => `${p}_${String(++n).padStart(4, '0')}`;
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const p = u.pathname;
    calls.push({ method: init.method, path: p + u.search, body });
    expect(u.origin).toBe('https://sandbox-api.paddle.com');
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(init.headers['Paddle-Version']).toBe('1');
    const ok = (data: unknown, meta?: unknown) => ({
      ok: true,
      status: 200,
      json: async () => ({ data, meta: meta ?? { pagination: { has_more: false } } }),
    });
    const find = (arr: any[], rid: string) => arr.find((x) => x.id === rid);
    const paged = (arr: any[]) => {
      const size = opts.pageSize ?? 1000;
      const start = Number(u.searchParams.get('after') ?? 0);
      const more = start + size < arr.length;
      const pid = u.searchParams.get('product_id');
      const next = more ? `https://sandbox-api.paddle.com${p}?after=${start + size}${pid ? `&product_id=${pid}` : ''}` : null;
      return ok(arr.slice(start, start + size), { pagination: { has_more: more, next } });
    };
    if (init.method === 'GET' && p === '/products') return paged(products);
    if (init.method === 'GET' && p === '/prices') return paged(prices.filter((x) => x.product_id === u.searchParams.get('product_id')));
    if (init.method === 'GET' && p === '/notification-settings') return paged(settings);
    if (init.method === 'POST' && p === '/products') {
      const row = { id: id('pro'), status: 'active', ...body };
      products.push(row);
      return ok(row);
    }
    if (init.method === 'POST' && p === '/prices') {
      // Real Paddle returns billing_cycle: null for one-time prices.
      const row = { id: id('pri'), status: 'active', billing_cycle: null, ...body };
      prices.push(row);
      return ok(row);
    }
    if (init.method === 'POST' && p === '/notification-settings') {
      const row = {
        id: id('ntfset'),
        active: true,
        ...(opts.omitSecret ? {} : { endpoint_secret_key: opts.secret ?? WH_SECRET }),
        ...body,
        // Paddle returns event objects, not bare names.
        subscribed_events: body.subscribed_events.map((name: string) => ({ name })),
      };
      settings.push(row);
      return ok(row);
    }
    if (init.method === 'POST' && p === '/client-tokens') return ok({ id: id('ctkn'), token: opts.token ?? TOKEN, ...body });
    if (init.method === 'PATCH') {
      const [, kind, rid] = p.split('/');
      const row = find(kind === 'prices' ? prices : kind === 'products' ? products : settings, rid!);
      if (!row) return { ok: false, status: 404, json: async () => ({ error: { code: 'not_found', detail: 'nope' } }) };
      Object.assign(row, body);
      if (body.subscribed_events) row.subscribed_events = body.subscribed_events.map((name: string) => ({ name }));
      return ok(row);
    }
    return { ok: false, status: 400, json: async () => ({ error: { code: 'bad_request', detail: `unhandled ${init.method} ${p}` } }) };
  };
  const writes = () => calls.filter((c) => c.method !== 'GET');
  return { fetch, calls, products, prices, settings, writes };
}

function tmpEnv(content: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'paddle-catalog-'));
  const file = path.join(dir, '.env.local');
  writeFileSync(file, content, { mode: 0o644 });
  return file;
}
const mode = (file: string) => statSync(file).mode & 0o777;
const envLines = (file: string) => readFileSync(file, 'utf8').split('\n');
const ENV0 = `# mine\nPADDLE_API_KEY=${KEY}\nOTHER=keep me\n`;

async function captured<T>(run: () => Promise<T>) {
  const lines: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a: unknown[]) => void lines.push(a.join(' '));
  try {
    return { result: await run(), output: lines.join('\n') };
  } finally {
    Object.assign(console, orig);
  }
}

describe('validateCatalog', () => {
  const bad = (mutate: (c: any) => void) => {
    const c = structuredClone(CATALOG) as any;
    mutate(c);
    return () => validateCatalog(c);
  };
  test('accepts a valid catalog and defaults taxCategory', () => {
    const c = structuredClone(CATALOG) as any;
    delete c.product.taxCategory;
    expect(validateCatalog(c).product.taxCategory).toBe('standard');
  });
  test('allows a string $schema (ignored) and rejects a non-string one', () => {
    const c = { ...structuredClone(CATALOG), $schema: './node_modules/paddle-kit/catalog.schema.json' } as any;
    const out = validateCatalog(c);
    expect(out).not.toHaveProperty('$schema');
    expect(out.app).toBe(CATALOG.app);
    for (const v of [1, null, {}, ['x']]) expect(bad((x) => (x.$schema = v))).toThrow(/catalog \$schema:/);
  });
  test('errors name the offending field', () => {
    expect(bad((c) => (c.app = ''))).toThrow(/catalog app:/);
    expect(bad((c) => delete c.product.name)).toThrow(/catalog product\.name:/);
    expect(bad((c) => (c.product.taxCategory = 'candy'))).toThrow(/catalog product\.taxCategory:/);
    expect(bad((c) => (c.prices = []))).toThrow(/catalog prices:/);
    expect(bad((c) => (c.prices[1].cycle = 'weekly'))).toThrow(/catalog prices\[1\]\.cycle:/);
    expect(bad((c) => (c.prices[2].amount = '14.99'))).toThrow(/catalog prices\[2\]\.amount:/);
    expect(bad((c) => (c.prices[0].currency = 'usd'))).toThrow(/catalog prices\[0\]\.currency:/);
    expect(bad((c) => (c.prices[0].key = '9x'))).toThrow(/catalog prices\[0\]\.key:/);
    expect(bad((c) => (c.prices[0].quantity = { min: 5, max: 2 }))).toThrow(/catalog prices\[0\]\.quantity\.max:/);
    expect(bad((c) => (c.prices[1] = { ...c.prices[0] }))).toThrow(/catalog prices\[1\]\.key: duplicate/);
    expect(() => validateCatalog('nope')).toThrow(CatalogError);
  });
});

describe('toPriceMap', () => {
  test('flat for once-only keys, nested for recurring', () => {
    const ids = { 'team25-monthly': 'pri_1', 'team25-yearly': 'pri_2', 'pack5-once': 'pri_3' };
    expect(toPriceMap(CATALOG, ids)).toEqual({ team25: { monthly: 'pri_1', yearly: 'pri_2' }, pack5: 'pri_3' });
  });
});

describe('syncCatalog', () => {
  test('refuses a non-sandbox key unless live, and calls nothing', async () => {
    const paddle = fakePaddle();
    for (const apiKey of ['pdl_live_abc123', 'garbage', '']) {
      const file = tmpEnv(`PADDLE_API_KEY=${apiKey}\n`);
      const { output, result } = await captured(() =>
        syncCatalog({ apiKey, catalog: CATALOG, envFile: file, fetch: paddle.fetch }).then(() => 'ran', (e: Error) => e.message),
      );
      expect(result).toMatch(/Sandbox API key required/);
      expect(output).not.toContain('pdl_live_abc123');
      expect(readFileSync(file, 'utf8')).toBe(`PADDLE_API_KEY=${apiKey}\n`);
    }
    expect(paddle.calls).toHaveLength(0);
  });

  test('the summary shows amounts in the currency\'s own minor unit (JPY has none, USD has cents)', async () => {
    const paddle = fakePaddle();
    const catalog: Catalog = { ...CATALOG, prices: [
      { key: 'pack', cycle: 'once', name: 'Pack (yen)', amount: '1500', currency: 'JPY' },
      { key: 'packusd', cycle: 'once', name: 'Pack', amount: '1499', currency: 'USD' },
    ] };
    const out = await syncCatalog({ apiKey: KEY, catalog, fetch: paddle.fetch, log: () => {} });
    const shown = out.rows.filter((r) => r[0]!.startsWith('price')).map((r) => r[2]);
    expect(shown).toEqual(['1500 JPY (created)', '14.99 USD (created)']);
  });

  test('creates the product and prices (one-time without billing_cycle) on an empty account', async () => {
    const paddle = fakePaddle();
    const file = tmpEnv(ENV0);
    const out = await syncCatalog({ apiKey: KEY, catalog: CATALOG, envFile: file, fetch: paddle.fetch, log: () => {} });

    expect(paddle.products).toHaveLength(1);
    expect(paddle.products[0]).toMatchObject({
      name: 'Demo',
      tax_category: 'standard',
      description: 'A demo app',
      custom_data: { paddle_kit: 'demo' },
    });
    expect(paddle.prices).toHaveLength(3);
    const byTag = Object.fromEntries(paddle.prices.map((p) => [p.custom_data.paddle_kit_price, p]));
    expect(byTag['team25-monthly']).toMatchObject({
      product_id: paddle.products[0].id,
      unit_price: { amount: '1000', currency_code: 'USD' },
      billing_cycle: { interval: 'month', frequency: 1 },
      quantity: { minimum: 1, maximum: 1 },
    });
    expect(byTag['team25-yearly'].billing_cycle).toEqual({ interval: 'year', frequency: 1 });
    // One-time: the request carries no billing_cycle at all (Paddle then stores null) and no quantity when not asked.
    const once = paddle.calls.find((c) => c.method === 'POST' && c.path === '/prices' && c.body.custom_data.paddle_kit_price === 'pack5-once')!;
    expect('billing_cycle' in once.body).toBe(false);
    expect('quantity' in once.body).toBe(false);
    expect(byTag['pack5-once'].billing_cycle).toBeNull();
    expect(byTag['pack5-once'].unit_price).toEqual({ amount: '1499', currency_code: 'USD' });
    // No destination or token without a webhook URL.
    expect(paddle.calls.some((c) => c.path.startsWith('/notification-settings') || c.path.startsWith('/client-tokens'))).toBe(false);

    expect(out.prices).toEqual({
      team25: { monthly: byTag['team25-monthly'].id, yearly: byTag['team25-yearly'].id },
      pack5: byTag['pack5-once'].id,
    });
    const lines = envLines(file);
    const written = JSON.parse(lines.find((l) => l.startsWith('PADDLE_PRICES='))!.slice('PADDLE_PRICES='.length));
    expect(written).toEqual(out.prices);
    expect(lines).toContain('PADDLE_ENV=sandbox');
    expect(out.written.sort()).toEqual(['PADDLE_ENV', 'PADDLE_PRICES']);
    expect(out.env).toBeUndefined();
  });

  test('a second run is a no-op; an amount change PATCHes only that price', async () => {
    const paddle = fakePaddle({ pageSize: 2 }); // exercises pagination too
    const file = tmpEnv(ENV0);
    await syncCatalog({ apiKey: KEY, catalog: CATALOG, envFile: file, webhookUrl: HOOK, fetch: paddle.fetch, log: () => {} });
    const ids = paddle.prices.map((p) => p.id);
    const before = readFileSync(file, 'utf8');

    paddle.calls.length = 0;
    await syncCatalog({ apiKey: KEY, catalog: CATALOG, envFile: file, webhookUrl: HOOK, fetch: paddle.fetch, log: () => {} });
    expect(paddle.writes()).toEqual([]);
    expect(paddle.products).toHaveLength(1);
    expect(paddle.settings).toHaveLength(1);
    expect(paddle.prices.map((p) => p.id)).toEqual(ids);
    expect(readFileSync(file, 'utf8')).toBe(before);

    const changed: Catalog = structuredClone(CATALOG);
    changed.prices[2]!.amount = '1999';
    paddle.calls.length = 0;
    await syncCatalog({ apiKey: KEY, catalog: changed, envFile: file, webhookUrl: HOOK, fetch: paddle.fetch, log: () => {} });
    const writes = paddle.writes();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: 'PATCH', path: `/prices/${ids[2]}` });
    expect(writes[0]!.body).toEqual({ unit_price: { amount: '1999', currency_code: 'USD' } });
    expect(paddle.prices[2].unit_price.amount).toBe('1999');
  });

  test('pins the destination to API version 1: on create, and repairs an existing one on another version', async () => {
    const paddle = fakePaddle();
    await syncCatalog({ apiKey: KEY, catalog: CATALOG, webhookUrl: HOOK, fetch: paddle.fetch, log: () => {} });
    expect(paddle.writes().find((c) => c.method === 'POST' && c.path === '/notification-settings')!.body.api_version).toBe(1);

    paddle.settings[0].api_version = 2;
    paddle.calls.length = 0;
    await syncCatalog({ apiKey: KEY, catalog: CATALOG, webhookUrl: HOOK, fetch: paddle.fetch, log: () => {} });
    expect(paddle.writes().filter((c) => c.path.startsWith('/notification-settings'))).toEqual([
      { method: 'PATCH', path: `/notification-settings/${paddle.settings[0].id}`, body: { api_version: 1 } },
    ]);
    expect(paddle.settings[0].api_version).toBe(1);
  });

  test('writes destination, secret, token and env; preserves unrelated lines; mode 0600', async () => {
    const paddle = fakePaddle();
    const file = tmpEnv(`# keep\nPADDLE_API_KEY=${KEY}\nPADDLE_PRICES=old\nRESEND_API_KEY=re_x\n\nSITE_URL=http://localhost:3000\n`);
    const out = await syncCatalog({ apiKey: KEY, catalog: CATALOG, envFile: file, webhookUrl: HOOK, fetch: paddle.fetch, log: () => {} });
    expect(mode(file)).toBe(0o600);
    const lines = envLines(file);
    expect(lines.slice(0, 2)).toEqual(['# keep', `PADDLE_API_KEY=${KEY}`]);
    expect(lines).toContain('RESEND_API_KEY=re_x');
    expect(lines).toContain('');
    expect(lines).toContain('SITE_URL=http://localhost:3000');
    expect(lines.filter((l) => l.startsWith('PADDLE_PRICES='))).toHaveLength(1);
    expect(lines).toContain(`PADDLE_NOTIFICATION_WEBHOOK_SECRET=${WH_SECRET}`);
    expect(lines).toContain(`NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=${TOKEN}`);
    expect(lines).toContain('PADDLE_ENV=sandbox');
    expect(out.written.sort()).toEqual(['NEXT_PUBLIC_PADDLE_CLIENT_TOKEN', 'PADDLE_ENV', 'PADDLE_NOTIFICATION_WEBHOOK_SECRET', 'PADDLE_PRICES']);

    expect(paddle.settings[0]).toMatchObject({
      description: 'demo (paddle-kit)',
      destination: HOOK,
      type: 'url',
      traffic_source: 'all',
      include_sensitive_fields: false,
    });
    expect(paddle.settings[0].subscribed_events.map((e: any) => e.name).sort()).toEqual([...EVENTS].sort());
    for (const e of ['transaction.completed', 'transaction.paid', 'adjustment.created', 'adjustment.updated', 'subscription.imported']) {
      expect(EVENTS).toContain(e);
    }
    expect(EVENTS).not.toContain('customer.created');
    expect(EVENTS).toHaveLength(13);
    expect(paddle.calls.filter((c) => c.path === '/client-tokens')).toHaveLength(1);
  });

  test('env is written incrementally: prices land on disk even when the destination step fails', async () => {
    const paddle = fakePaddle();
    const file = tmpEnv(ENV0);
    const flaky: FetchLike = async (url, init) =>
      init.method === 'POST' && new URL(url).pathname === '/notification-settings'
        ? { ok: false, status: 500, json: async () => ({ error: { code: 'internal', detail: 'boom' } }) }
        : paddle.fetch(url, init);
    await expect(syncCatalog({ apiKey: KEY, catalog: CATALOG, envFile: file, webhookUrl: HOOK, fetch: flaky, log: () => {} })).rejects.toThrow(
      'POST /notification-settings failed: 500 internal: boom',
    );
    const lines = envLines(file);
    expect(lines.some((l) => l.startsWith('PADDLE_PRICES={'))).toBe(true);
    expect(lines.some((l) => l.startsWith('PADDLE_NOTIFICATION_WEBHOOK_SECRET'))).toBe(false);
  });

  test('existing destination: secret read from it, repointed, events repaired, no new token', async () => {
    const paddle = fakePaddle();
    const file = tmpEnv(ENV0);
    await syncCatalog({ apiKey: KEY, catalog: CATALOG, envFile: file, webhookUrl: 'https://one.example/hook', fetch: paddle.fetch, log: () => {} });
    // Simulate an older destination (v0.2 events) and a lost secret line.
    paddle.settings[0].subscribed_events = [{ name: 'subscription.created' }];
    writeFileSync(file, readFileSync(file, 'utf8').split('\n').filter((l) => !l.startsWith('PADDLE_NOTIFICATION_WEBHOOK_SECRET')).join('\n'));

    paddle.calls.length = 0;
    await syncCatalog({ apiKey: KEY, catalog: CATALOG, envFile: file, webhookUrl: 'https://two.example/hook', fetch: paddle.fetch, log: () => {} });
    expect(paddle.settings).toHaveLength(1);
    expect(paddle.settings[0].destination).toBe('https://two.example/hook');
    expect(paddle.settings[0].subscribed_events).toHaveLength(EVENTS.length);
    expect(paddle.writes()).toHaveLength(1);
    expect(paddle.writes()[0]).toMatchObject({ method: 'PATCH' });
    expect(paddle.calls.some((c) => c.path === '/client-tokens')).toBe(false);
    expect(envLines(file)).toContain(`PADDLE_NOTIFICATION_WEBHOOK_SECRET=${WH_SECRET}`);
  });

  test('never writes "undefined": a destination without a secret leaves the variable unset', async () => {
    const paddle = fakePaddle({ omitSecret: true });
    const file = tmpEnv(ENV0);
    const logs: string[] = [];
    await syncCatalog({ apiKey: KEY, catalog: CATALOG, envFile: file, webhookUrl: HOOK, fetch: paddle.fetch, log: (l) => logs.push(l) });
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/undefined|null/);
    expect(text).not.toContain('PADDLE_NOTIFICATION_WEBHOOK_SECRET');
    expect(logs.join('\n')).toContain('copy it from the Paddle dashboard');

    writeEnvFile(file, { A: undefined, B: 'undefined', C: '', D: 'ok' });
    expect(readEnvFile(file)).toMatchObject({ D: 'ok' });
    expect(readFileSync(file, 'utf8')).not.toMatch(/^A=|^B=|^C=/m);
  });

  test('without an envFile nothing is written and the values come back', async () => {
    const paddle = fakePaddle();
    const out = await syncCatalog({ apiKey: KEY, catalog: CATALOG, webhookUrl: HOOK, fetch: paddle.fetch, log: () => {} });
    expect(out.written).toEqual([]);
    expect(out.env).toMatchObject({
      PADDLE_ENV: 'sandbox',
      PADDLE_NOTIFICATION_WEBHOOK_SECRET: WH_SECRET,
      NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: TOKEN,
    });
  });

  test('teardown archives only marked prices of the marked product and deactivates the destination', async () => {
    const paddle = fakePaddle();
    const file = tmpEnv(ENV0);
    await syncCatalog({ apiKey: KEY, catalog: CATALOG, envFile: file, webhookUrl: HOOK, fetch: paddle.fetch, log: () => {} });
    // A foreign product with its own marked-looking price, and a different app's destination.
    paddle.products.push({ id: 'pro_other', status: 'active', custom_data: { paddle_kit: 'other' } });
    paddle.prices.push({ id: 'pri_other', status: 'active', product_id: 'pro_other', custom_data: { paddle_kit_price: 'x-once' } });
    paddle.settings.push({ id: 'ntfset_other', description: 'other (paddle-kit)', active: true });

    paddle.calls.length = 0;
    await syncCatalog({ apiKey: KEY, catalog: CATALOG, envFile: file, teardown: true, fetch: paddle.fetch, log: () => {} });
    expect(paddle.settings[0].active).toBe(false);
    expect(paddle.prices.filter((p) => p.product_id === paddle.products[0].id).every((p) => p.status === 'archived')).toBe(true);
    expect(paddle.products[0].status).toBe('archived');
    expect(paddle.prices.find((p) => p.id === 'pri_other').status).toBe('active');
    expect(paddle.products[1].status).toBe('active');
    expect(paddle.settings[1].active).toBe(true);
  });

  test('teardown leaves the product (and unmarked prices) alone when prices paddle-kit did not create exist', async () => {
    const paddle = fakePaddle();
    await syncCatalog({ apiKey: KEY, catalog: CATALOG, fetch: paddle.fetch, log: () => {} });
    const manual = { id: 'pri_manual', status: 'active', product_id: paddle.products[0].id, custom_data: null };
    paddle.prices.push(manual);
    await syncCatalog({ apiKey: KEY, catalog: CATALOG, teardown: true, fetch: paddle.fetch, log: () => {} });
    expect(manual.status).toBe('active');
    expect(paddle.products[0].status).toBe('active');
    expect(paddle.prices.filter((p) => p.custom_data?.paddle_kit_price).every((p) => p.status === 'archived')).toBe(true);
  });

  test('live: a live key is accepted only with live=true, and test_ client tokens are refused', async () => {
    const paddle = fakePaddle();
    const calls: string[] = [];
    const liveFetch: FetchLike = (url, init) => {
      calls.push(new URL(url).origin);
      return paddle.fetch(url.replace('https://api.paddle.com', 'https://sandbox-api.paddle.com'), {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${KEY}` },
      });
    };
    const file = tmpEnv(ENV0);
    await expect(
      syncCatalog({ apiKey: 'pdl_live_abc', catalog: CATALOG, envFile: file, webhookUrl: HOOK, live: true, fetch: liveFetch, log: () => {} }),
    ).rejects.toThrow(/Refusing a test_ client token with --live/);
    expect(new Set(calls)).toEqual(new Set(['https://api.paddle.com']));
    expect(readFileSync(file, 'utf8')).not.toContain(TOKEN);
    expect(readFileSync(file, 'utf8')).toContain('PADDLE_ENV=production');

    // An existing test_ token in the env file is refused too, before any token call.
    const file2 = tmpEnv(`${ENV0}NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=test_old\n`);
    await expect(
      syncCatalog({ apiKey: 'pdl_live_abc', catalog: CATALOG, envFile: file2, webhookUrl: HOOK, live: true, fetch: liveFetch, log: () => {} }),
    ).rejects.toThrow(/Refusing to use a test_ client token/);

    // A live token passes.
    const ok = fakePaddle({ token: 'live_realtoken123' });
    const file3 = tmpEnv(ENV0);
    await syncCatalog({
      apiKey: 'pdl_live_abc',
      catalog: CATALOG,
      envFile: file3,
      webhookUrl: HOOK,
      live: true,
      fetch: (url, init) => ok.fetch(url.replace('https://api.paddle.com', 'https://sandbox-api.paddle.com'), { ...init, headers: { ...init.headers, Authorization: `Bearer ${KEY}` } }),
      log: () => {},
    });
    expect(envLines(file3)).toContain('NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=live_realtoken123');
  });

  test('does not follow a pagination link to another host', async () => {
    const evil: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [], meta: { pagination: { has_more: true, next: 'https://evil.example/products?x=1' } } }),
    });
    await expect(syncCatalog({ apiKey: KEY, catalog: CATALOG, fetch: evil, log: () => {} })).rejects.toThrow('pagination link points to another host');
  });

  test('never prints the API key or any secret', async () => {
    const paddle = fakePaddle();
    const file = tmpEnv(ENV0);
    const { output } = await captured(async () => {
      await syncCatalog({ apiKey: KEY, catalog: CATALOG, envFile: file, webhookUrl: HOOK, fetch: paddle.fetch });
      await syncCatalog({ apiKey: KEY, catalog: CATALOG, envFile: file, teardown: true, fetch: paddle.fetch });
    });
    expect(output.length).toBeGreaterThan(0);
    for (const secret of [KEY, WH_SECRET, TOKEN, 'SECRET_VALUE', 'SECRET_endpoint', 'clienttoken']) expect(output).not.toContain(secret);
    expect(output).toContain('PADDLE_PRICES');

    // Error path prints method, path, status, code, detail only.
    const failing: FetchLike = async () => ({ ok: false, status: 403, json: async () => ({ error: { code: 'forbidden', detail: 'no access' } }) });
    const message = await syncCatalog({ apiKey: KEY, catalog: CATALOG, fetch: failing }).then(() => '', (e: Error) => e.message);
    expect(message).toBe('GET /products?per_page=200 failed: 403 forbidden: no access');
    expect(message).not.toContain(KEY);
  });
});

describe('paddle-kit-catalog cli', () => {
  test('parseArgs defaults, flags and errors', () => {
    expect(parseArgs([])).toEqual({ catalog: 'paddle.catalog.json', envFile: '.env.local', teardown: false, live: false, help: false });
    expect(parseArgs(['--catalog', 'c.json', '--env-file', 'e', '--webhook-url', 'https://x.example/h', '--teardown', '--live'])).toEqual({
      catalog: 'c.json',
      envFile: 'e',
      webhookUrl: 'https://x.example/h',
      teardown: true,
      live: true,
      help: false,
    });
    // the https rule lives once, in syncCatalog (tested below with every non-https shape), before any request
    expect(parseArgs(['--webhook-url', 'http://x']).webhookUrl).toBe('http://x');
    expect(() => parseArgs(['--catalog'])).toThrow('--catalog needs a value');
    expect(() => parseArgs(['--nope'])).toThrow('unknown option: --nope');
  });

  test('main prints a clear catalog error, exits 1, and never the key', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'paddle-catalog-cli-'));
    const envFile = path.join(dir, '.env');
    const catalog = path.join(dir, 'c.json');
    writeFileSync(envFile, `PADDLE_API_KEY=${KEY}\n`);
    writeFileSync(catalog, JSON.stringify({ ...CATALOG, prices: [{ ...CATALOG.prices[0], amount: 'ten' }] }));
    const { result, output } = await captured(() => main(['--catalog', catalog, '--env-file', envFile]));
    expect(result).toBe(1);
    expect(output).toContain('catalog prices[0].amount:');
    expect(output).not.toContain(KEY);

    const none = path.join(dir, 'missing.env');
    const prev = process.env.PADDLE_API_KEY;
    delete process.env.PADDLE_API_KEY;
    try {
      const r = await captured(() => main(['--catalog', catalog, '--env-file', none]));
      expect(r.result).toBe(1);
      expect(r.output).toContain('PADDLE_API_KEY not found');
    } finally {
      if (prev !== undefined) process.env.PADDLE_API_KEY = prev;
    }
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('fix round 1', () => {
  const failWith = (status: number, body: unknown): FetchLike => async () => ({ ok: false, status, json: async () => body });

  test('I1: a key planted in a 403 detail or a 500 body never reaches the thrown message or the console', async () => {
    const detail403 = failWith(403, { error: { code: 'forbidden', detail: `bad key ${KEY} for you` } });
    const msg = await syncCatalog({ apiKey: KEY, catalog: CATALOG, fetch: detail403, log: () => {} }).then(() => '', (e: Error) => e.message);
    expect(msg).toContain('403 forbidden');
    expect(msg).not.toContain(KEY);
    expect(msg).not.toContain('SECRET_VALUE');
    expect(msg).toContain('[redacted]');

    // 500 whose code carries the key too, through the real CLI path (global fetch stubbed).
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500, json: async () => ({ error: { code: KEY, detail: `Bearer ${KEY}` } }) }));
    const dir = mkdtempSync(path.join(tmpdir(), 'paddle-catalog-cli-'));
    const envFile = path.join(dir, '.env');
    const catalog = path.join(dir, 'c.json');
    writeFileSync(envFile, `PADDLE_API_KEY=${KEY}\n`);
    writeFileSync(catalog, JSON.stringify(CATALOG));
    const prev = process.env.PADDLE_API_KEY;
    delete process.env.PADDLE_API_KEY;
    try {
      const { result, output } = await captured(() => main(['--catalog', catalog, '--env-file', envFile]));
      expect(result).toBe(1);
      expect(output).toContain('500');
      expect(output).not.toContain(KEY);
      expect(output).not.toContain('SECRET_VALUE');
    } finally {
      if (prev !== undefined) process.env.PADDLE_API_KEY = prev;
    }
  });

  test('I1: the webhook secret and token-shaped strings are redacted even when they match no known prefix', async () => {
    const SECRET = 'plain-secret-without-a-prefix-9d8f7a';
    const paddle = fakePaddle({ secret: SECRET });
    const wrapped: FetchLike = (url, init) =>
      init.method === 'POST' && new URL(url).pathname === '/client-tokens'
        ? Promise.resolve({ ok: false, status: 403, json: async () => ({ error: { code: 'forbidden', detail: `echo ${SECRET} and ${TOKEN} and live_abcdef123456` } }) })
        : paddle.fetch(url, init);
    const msg = await syncCatalog({ apiKey: KEY, catalog: CATALOG, webhookUrl: HOOK, fetch: wrapped, log: () => {} }).then(() => '', (e: Error) => e.message);
    expect(msg).toContain('403 forbidden');
    for (const leak of [SECRET, TOKEN, 'live_abcdef123456']) expect(msg).not.toContain(leak);

    expect(redactSecrets('a pdl_live_xyz1 b pdl_sdbx_k_2 c pdl_ntfset_q_9 d test_abcdefgh e live_abcdefgh f')).toBe(
      'a [redacted] b [redacted] c [redacted] d [redacted] e [redacted] f',
    );
    expect(redactSecrets('Sandbox API key required (pdl_sdbx_…) and test_ tokens')).toBe('Sandbox API key required (pdl_sdbx_…) and test_ tokens');
  });

  test('I2/M1: every environment mix is refused before any request, with the env file untouched', async () => {
    const paddle = fakePaddle();
    const cases: Array<{ name: string; apiKey: string; live: boolean; env: string; match: RegExp }> = [
      { name: 'live key + live + existing test_ token', apiKey: 'pdl_live_abc', live: true, env: `${ENV0}NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=test_old\n`, match: /Refusing to use a test_ client token/ },
      { name: 'sandbox key + live flag', apiKey: KEY, live: true, env: ENV0, match: /--live .*sandbox key|sandbox key.*--live/i },
      { name: 'live key without live flag', apiKey: 'pdl_live_abc', live: false, env: ENV0, match: /Sandbox API key required/ },
    ];
    for (const c of cases) {
      const file = tmpEnv(c.env);
      const before = readFileSync(file, 'utf8');
      await expect(
        syncCatalog({ apiKey: c.apiKey, catalog: CATALOG, envFile: file, webhookUrl: HOOK, live: c.live, fetch: paddle.fetch, log: () => {} }),
        c.name,
      ).rejects.toThrow(c.match);
      expect(paddle.calls, c.name).toHaveLength(0);
      expect(readFileSync(file, 'utf8'), c.name).toBe(before);
    }
    // Same refusal without --webhook-url (the mix is about the file, not the destination step).
    const file = tmpEnv(`${ENV0}NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=test_old\n`);
    await expect(syncCatalog({ apiKey: 'pdl_live_abc', catalog: CATALOG, envFile: file, live: true, fetch: paddle.fetch, log: () => {} })).rejects.toThrow(/test_ client token/);
    expect(paddle.calls).toHaveLength(0);
  });

  test('M8: a bad webhook URL is refused before any request', async () => {
    const paddle = fakePaddle();
    for (const webhookUrl of ['http://x.example/h', 'not a url', 'https://', 'ftp://x.example']) {
      await expect(syncCatalog({ apiKey: KEY, catalog: CATALOG, webhookUrl, fetch: paddle.fetch, log: () => {} }), webhookUrl).rejects.toThrow(/https URL/);
    }
    expect(paddle.calls).toHaveLength(0);
  });

  test('M2: duplicate lines for one key are collapsed to the first position', () => {
    const file = tmpEnv('A=1\nPADDLE_ENV=old1\nB=2\nPADDLE_ENV=old2\nC=3\n');
    writeEnvFile(file, { PADDLE_ENV: 'sandbox' });
    expect(readFileSync(file, 'utf8')).toBe('A=1\nPADDLE_ENV=sandbox\nB=2\nC=3\n');
    // Converged: a second write is a no-op.
    expect(writeEnvFile(file, { PADDLE_ENV: 'sandbox' })).toEqual([]);
  });

  test('M4: unknown keys are rejected by name at every level', () => {
    const mut = (f: (c: any) => void) => {
      const c = structuredClone(CATALOG) as any;
      f(c);
      return () => validateCatalog(c);
    };
    expect(mut((c) => (c.prices[0].quantiy = { min: 1, max: 5 }))).toThrow(/prices\[0\]\.quantiy: unknown key/);
    expect(mut((c) => (c.product.taxcategory = 'saas'))).toThrow(/product\.taxcategory: unknown key/);
    expect(mut((c) => (c.price = []))).toThrow(/catalog price: unknown key/);
    expect(mut((c) => (c.prices[0].quantity.maxx = 3))).toThrow(/prices\[0\]\.quantity\.maxx: unknown key/);
  });

  test('M5: a no-op run still tightens the env file to 0600', async () => {
    const paddle = fakePaddle();
    const file = tmpEnv(ENV0);
    await syncCatalog({ apiKey: KEY, catalog: CATALOG, envFile: file, fetch: paddle.fetch, log: () => {} });
    chmodSync(file, 0o644);
    await syncCatalog({ apiKey: KEY, catalog: CATALOG, envFile: file, fetch: paddle.fetch, log: () => {} });
    expect(mode(file)).toBe(0o600);
    chmodSync(file, 0o644);
    await syncCatalog({ apiKey: KEY, catalog: CATALOG, envFile: file, teardown: true, fetch: paddle.fetch, log: () => {} });
    expect(mode(file)).toBe(0o600);
  });
});
