// Idempotent Paddle catalog sync: products, prices, webhook destination, client token, env file.
// Node-only (uses node:fs for the env file). Never prints or returns the API key; never logs a secret.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const SANDBOX_BASE = 'https://sandbox-api.paddle.com';
export const LIVE_BASE = 'https://api.paddle.com';

/** Everything paddle-kit's webhook handler understands. */
export const EVENTS: readonly string[] = [
  'subscription.created',
  'subscription.updated',
  'subscription.activated',
  'subscription.trialing',
  'subscription.past_due',
  'subscription.paused',
  'subscription.resumed',
  'subscription.canceled',
  'subscription.imported',
  'customer.created',
  'customer.updated',
  'transaction.completed',
  'transaction.paid',
  'adjustment.created',
  'adjustment.updated',
];

export type Cycle = 'monthly' | 'yearly' | 'once';
const CYCLES: readonly Cycle[] = ['monthly', 'yearly', 'once'];
const TAX_CATEGORIES = [
  'digital-goods',
  'ebooks',
  'implementation-services',
  'professional-services',
  'saas',
  'software-programming-services',
  'standard',
  'training-services',
  'website-hosting',
] as const;

export interface CatalogPrice {
  key: string;
  cycle: Cycle;
  name: string;
  /** Lowest currency unit as a string, e.g. "1000" = 10.00 USD. */
  amount: string;
  currency: string;
  description?: string;
  quantity?: { min: number; max: number };
}

export interface Catalog {
  app: string;
  product: { name: string; taxCategory: (typeof TAX_CATEGORIES)[number]; description?: string };
  prices: CatalogPrice[];
}

/** key -> priceId (once-only keys) or key -> { cycle -> priceId } */
export type PriceMap = Record<string, string | Record<string, string>>;

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class CatalogError extends Error {
  override name = 'CatalogError';
}
export class PaddleError extends Error {
  override name = 'PaddleError';
}

// ---------- redaction ----------

const TOKEN_SHAPE = /\b(?:pdl_(?:sdbx|live)_[A-Za-z0-9_]+|test_[A-Za-z0-9]{8,}|live_[A-Za-z0-9]{8,}|pdl_ntfset_[A-Za-z0-9_]+)\b/g;

/** Removes known secret values and anything shaped like a Paddle key/token/secret from text. */
export function redactSecrets(text: string, known: readonly string[] = []): string {
  let out = text;
  for (const secret of known) if (secret.length >= 6) out = out.split(secret).join('[redacted]');
  return out.replace(TOKEN_SHAPE, '[redacted]');
}

// ---------- catalog validation ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

function fail(field: string, why: string): never {
  throw new CatalogError(`catalog ${field}: ${why}`);
}

function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail(where ? `${where}.${k}` : k, `unknown key (allowed: ${allowed.join(', ')})`);
  }
}

export function validateCatalog(input: unknown): Catalog {
  if (!isObj(input)) fail('(root)', 'must be a JSON object');
  onlyKeys(input, ['$schema', 'app', 'product', 'prices'], '');
  if (input.$schema !== undefined && typeof input.$schema !== 'string') fail('$schema', 'must be a string');
  const { app, product, prices } = input;
  if (!nonEmpty(app) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(app)) {
    fail('app', 'must be a non-empty identifier (letters, digits, . _ -)');
  }
  if (!isObj(product)) fail('product', 'must be an object');
  onlyKeys(product, ['name', 'taxCategory', 'description'], 'product');
  if (!nonEmpty(product.name)) fail('product.name', 'must be a non-empty string');
  const taxCategory = product.taxCategory === undefined ? 'standard' : product.taxCategory;
  if (typeof taxCategory !== 'string' || !(TAX_CATEGORIES as readonly string[]).includes(taxCategory)) {
    fail('product.taxCategory', `must be one of ${TAX_CATEGORIES.join(', ')}`);
  }
  if (product.description !== undefined && typeof product.description !== 'string') {
    fail('product.description', 'must be a string');
  }
  if (!Array.isArray(prices) || prices.length === 0) fail('prices', 'must be a non-empty array');

  const seen = new Set<string>();
  const out: CatalogPrice[] = prices.map((raw: unknown, i: number) => {
    const at = (f: string) => `prices[${i}].${f}`;
    if (!isObj(raw)) fail(`prices[${i}]`, 'must be an object');
    onlyKeys(raw, ['key', 'cycle', 'name', 'amount', 'currency', 'description', 'quantity'], `prices[${i}]`);
    if (!nonEmpty(raw.key) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(raw.key)) {
      fail(at('key'), 'must start with a letter and use only letters, digits and _');
    }
    if (typeof raw.cycle !== 'string' || !(CYCLES as readonly string[]).includes(raw.cycle)) {
      fail(at('cycle'), `must be one of ${CYCLES.join(', ')}`);
    }
    const cycle = raw.cycle as Cycle;
    if (!nonEmpty(raw.name)) fail(at('name'), 'must be a non-empty string');
    const amountIn = raw.amount;
    const amount =
      typeof amountIn === 'number' && Number.isSafeInteger(amountIn) && amountIn >= 0 ? String(amountIn) : amountIn;
    if (typeof amount !== 'string' || !/^\d+$/.test(amount)) {
      fail(at('amount'), 'must be a whole number in the lowest currency unit, as a string (e.g. "1000")');
    }
    if (typeof raw.currency !== 'string' || !/^[A-Z]{3}$/.test(raw.currency)) {
      fail(at('currency'), 'must be a 3-letter upper-case ISO code (e.g. "USD")');
    }
    if (raw.description !== undefined && typeof raw.description !== 'string') fail(at('description'), 'must be a string');
    let quantity: CatalogPrice['quantity'];
    if (raw.quantity !== undefined) {
      const q = raw.quantity;
      if (!isObj(q)) fail(at('quantity'), 'must be an object { min, max }');
      onlyKeys(q, ['min', 'max'], at('quantity'));
      const { min, max } = q;
      if (typeof min !== 'number' || !Number.isSafeInteger(min) || min < 1) fail(at('quantity.min'), 'must be an integer >= 1');
      if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < min) {
        fail(at('quantity.max'), 'must be an integer >= quantity.min');
      }
      quantity = { min, max };
    }
    const tag = `${raw.key}-${cycle}`;
    if (seen.has(tag)) fail(at('key'), `duplicate price "${raw.key}" with cycle "${cycle}"`);
    seen.add(tag);
    const price: CatalogPrice = { key: raw.key, cycle, name: raw.name, amount, currency: raw.currency };
    if (typeof raw.description === 'string') price.description = raw.description;
    if (quantity) price.quantity = quantity;
    return price;
  });

  const cleaned: Catalog = {
    app,
    product: { name: product.name, taxCategory: taxCategory as Catalog['product']['taxCategory'] },
    prices: out,
  };
  if (typeof product.description === 'string') cleaned.product.description = product.description;
  return cleaned;
}

/** Reads and validates a catalog JSON file. */
export function readCatalogFile(file: string): Catalog {
  if (!existsSync(file)) throw new CatalogError(`catalog file not found: ${file}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new CatalogError(`catalog file is not valid JSON: ${file}`);
  }
  return validateCatalog(parsed);
}

/** Groups prices into the PriceMap the app puts in PADDLE_PRICES. */
export function toPriceMap(catalog: Catalog, ids: Record<string, string>): PriceMap {
  const map: PriceMap = {};
  for (const p of catalog.prices) {
    const id = ids[`${p.key}-${p.cycle}`];
    if (!id) continue;
    const onlyOnce = catalog.prices.filter((x) => x.key === p.key).every((x) => x.cycle === 'once');
    if (onlyOnce) {
      map[p.key] = id;
    } else {
      const entry = (map[p.key] ??= {}) as Record<string, string>;
      entry[p.cycle] = id;
    }
  }
  return map;
}

// ---------- .env file ----------

export function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    let value = (m[2] ?? '').trim();
    if (value.length > 1 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    out[m[1]!] = value;
  }
  return out;
}

// Replaces existing KEY= lines, appends missing ones, keeps every other line. Never writes an
// empty value or the literal "undefined"/"null" (those would silently break the app).
export function writeEnvFile(file: string, updates: Record<string, string | undefined>): string[] {
  const clean = new Map<string, string>();
  for (const [k, v] of Object.entries(updates)) {
    if (typeof v !== 'string' || v === '' || v === 'undefined' || v === 'null') continue;
    if (/[\r\n]/.test(v)) continue;
    clean.set(k, v);
  }
  const current = readEnvFile(file);
  for (const [k, v] of [...clean]) if (current[k] === v) clean.delete(k);
  if (clean.size === 0) return [];
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const pending = new Map(clean);
  const replaced = new Set<string>();
  const next: string[] = [];
  for (const line of lines) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = m?.[1];
    if (key && clean.has(key)) {
      // First occurrence is rewritten in place; later duplicates are dropped (readers are last-wins).
      if (!replaced.has(key)) next.push(`${key}=${clean.get(key)!}`);
      replaced.add(key);
      pending.delete(key);
      continue;
    }
    next.push(line);
  }
  for (const [k, v] of pending) next.push(`${k}=${v}`);
  writeFileSync(file, next.join('\n') + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return [...clean.keys()];
}

// ---------- Paddle HTTP ----------

type Json = Record<string, any>;

function paddleClient(base: string, apiKey: string, fetchImpl: FetchLike, known: string[]) {
  async function call(method: string, apiPath: string, body?: unknown): Promise<Json> {
    const res = await fetchImpl(base + apiPath, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let parsed: Json = {};
    try {
      parsed = (await res.json()) as Json;
    } catch {
      parsed = {};
    }
    if (!res.ok) {
      const err = parsed?.error ?? {};
      throw new PaddleError(
        redactSecrets(`${method} ${apiPath} failed: ${res.status} ${String(err.code ?? 'unknown_error')}: ${String(err.detail ?? 'no detail')}`, known),
      );
    }
    return parsed;
  }
  // Follows meta.pagination.next while has_more; never follows a link to another host (the key would leak).
  async function list(apiPath: string): Promise<Json[]> {
    const items: Json[] = [];
    let next: string | null = apiPath;
    for (let page = 0; next && page < 50; page++) {
      const res: Json = await call('GET', next);
      items.push(...((res.data as Json[]) ?? []));
      const pagination = res.meta?.pagination;
      next = null;
      if (pagination?.has_more && pagination.next) {
        const u = new URL(String(pagination.next), base);
        if (u.origin !== new URL(base).origin || u.protocol !== 'https:') throw new PaddleError('pagination link points to another host');
        next = u.pathname + u.search;
      }
    }
    return items;
  }
  return { call, list };
}

// ---------- sync ----------

export interface SyncOptions {
  apiKey: string;
  catalog: Catalog;
  /** Full https URL Paddle should POST to. Enables the destination and client-token steps (PADDLE_ENV is always written). */
  webhookUrl?: string;
  /** Env file to read/write incrementally (mode 0600). Without it nothing is written and `env` is returned. */
  envFile?: string;
  /** Archive the marked prices and product, deactivate the destination. */
  teardown?: boolean;
  /** Allow a non-sandbox key. Client tokens starting with test_ are then refused. */
  live?: boolean;
  fetch?: FetchLike;
  log?: (line: string) => void;
}

export interface SyncResult {
  environment: 'sandbox' | 'production';
  productId: string | null;
  priceIds: Record<string, string>;
  prices: PriceMap;
  rows: string[][];
  /** Names of env variables written to `envFile`. */
  written: string[];
  /** Only when no `envFile` was given: the values that would have been written. Contains secrets. */
  env?: Record<string, string>;
}

const isActive = (item: Json) => item.status !== 'archived';
const sameSet = (a: unknown, b: readonly string[]) => {
  if (!Array.isArray(a)) return false;
  const x = new Set(a.map(String));
  return x.size === b.length && b.every((e) => x.has(e));
};

export function describeKey(apiKey: string, live: boolean): 'sandbox' | 'production' {
  if (apiKey.startsWith('pdl_sdbx_')) {
    if (live) throw new PaddleError('--live was given with a sandbox key (pdl_sdbx_…): drop --live, or use a live key');
    return 'sandbox';
  }
  if (!live) throw new PaddleError('Sandbox API key required (pdl_sdbx_…). Pass --live to use a live key on purpose.');
  if (!apiKey.startsWith('pdl_live_')) throw new PaddleError('Unrecognised API key: expected pdl_sdbx_… or (with --live) pdl_live_…');
  return 'production';
}

export async function syncCatalog(opts: SyncOptions): Promise<SyncResult> {
  const known: string[] = [opts.apiKey];
  const sink = opts.log ?? ((line: string) => console.log(line));
  const log = (line: string) => sink(redactSecrets(line, known));
  const live = opts.live === true;

  // Every environment check happens here, before the first request and before the env file is touched.
  const catalog = validateCatalog(opts.catalog);
  const environment = describeKey(opts.apiKey ?? '', live); // liveness comes from the key prefix, not only the flag
  if (opts.webhookUrl !== undefined) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(opts.webhookUrl);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.protocol !== 'https:' || !parsed.hostname) throw new PaddleError('webhookUrl needs an https URL');
  }
  const env = opts.envFile ? readEnvFile(opts.envFile) : {};
  if (environment === 'production' && !opts.teardown && env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN?.startsWith('test_')) {
    throw new PaddleError('Refusing to use a test_ client token with --live: use a separate env file for live (--env-file .env.production.local --live)');
  }

  const fetchImpl: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const paddle = paddleClient(environment === 'sandbox' ? SANDBOX_BASE : LIVE_BASE, opts.apiKey, fetchImpl, known);
  const destinationName = `${catalog.app} (paddle-kit)`;
  const rows: string[][] = [];
  const written: string[] = [];
  const pendingEnv: Record<string, string> = {};

  // Incremental: each stage lands on disk before the next network call.
  const put = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) if (typeof v === 'string' && v !== '' && v !== 'undefined') pendingEnv[k] = v;
    if (opts.envFile) for (const k of writeEnvFile(opts.envFile, values)) if (!written.includes(k)) written.push(k);
  };
  const done = (productId: string | null, priceIds: Record<string, string>): SyncResult => {
    printTable(log, rows);
    if (written.length) log(`Wrote to ${path.basename(opts.envFile ?? '')}: ${written.join(', ')}`);
    // The file holds secrets: tighten it even when this run changed nothing.
    if (opts.envFile && existsSync(opts.envFile)) chmodSync(opts.envFile, 0o600);
    const result: SyncResult = { environment, productId, priceIds, prices: toPriceMap(catalog, priceIds), rows, written };
    if (!opts.envFile) result.env = { ...pendingEnv };
    return result;
  };

  const products = await paddle.list('/products?per_page=200');
  let product = products.find((p) => isActive(p) && p.custom_data?.paddle_kit === catalog.app);

  if (opts.teardown) {
    const destinations = await paddle.list('/notification-settings');
    const destination = destinations.find((d) => d.description === destinationName);
    if (destination) {
      await paddle.call('PATCH', `/notification-settings/${destination.id}`, { active: false });
      rows.push(['destination (deactivated)', destination.id, '']);
    }
    if (product) {
      const prices = (await paddle.list(`/prices?product_id=${product.id}&per_page=200`)).filter(isActive);
      let unmarked = 0;
      for (const price of prices) {
        if (typeof price.custom_data?.paddle_kit_price !== 'string') {
          unmarked++;
          continue;
        }
        await paddle.call('PATCH', `/prices/${price.id}`, { status: 'archived' });
        rows.push([`price ${price.custom_data.paddle_kit_price} (archived)`, price.id, '']);
      }
      if (unmarked === 0) {
        await paddle.call('PATCH', `/products/${product.id}`, { status: 'archived' });
        rows.push(['product (archived)', product.id, '']);
      } else {
        rows.push(['product (kept: has prices paddle-kit did not create)', product.id, `${unmarked} active`]);
      }
    }
    return done(product?.id ?? null, {});
  }

  const wantedProduct = {
    name: catalog.product.name,
    tax_category: catalog.product.taxCategory,
    ...(catalog.product.description !== undefined ? { description: catalog.product.description } : {}),
  };
  if (!product) {
    product = (await paddle.call('POST', '/products', { ...wantedProduct, custom_data: { paddle_kit: catalog.app } })).data;
    rows.push(['product (created)', product!.id, catalog.product.name]);
  } else {
    const drift: Json = {};
    if (product.name !== wantedProduct.name) drift.name = wantedProduct.name;
    if (product.tax_category !== wantedProduct.tax_category) drift.tax_category = wantedProduct.tax_category;
    if (wantedProduct.description !== undefined && (product.description ?? null) !== wantedProduct.description) {
      drift.description = wantedProduct.description;
    }
    if (Object.keys(drift).length) await paddle.call('PATCH', `/products/${product.id}`, drift);
    rows.push([`product${Object.keys(drift).length ? ' (updated)' : ''}`, product.id, catalog.product.name]);
  }

  const existing = (await paddle.list(`/prices?product_id=${product!.id}&per_page=200`)).filter(isActive);
  const ids: Record<string, string> = {};
  for (const want of catalog.prices) {
    const tag = `${want.key}-${want.cycle}`;
    const unitPrice = { amount: want.amount, currency_code: want.currency };
    const quantity = want.quantity ? { minimum: want.quantity.min, maximum: want.quantity.max } : undefined;
    let price = existing.find((p) => p.custom_data?.paddle_kit_price === tag);
    let note = '';
    if (!price) {
      price = (
        await paddle.call('POST', '/prices', {
          product_id: product!.id,
          name: want.name,
          description: want.description ?? want.name,
          unit_price: unitPrice,
          // `once` = a one-time price: no billing_cycle at all.
          ...(want.cycle === 'once' ? {} : { billing_cycle: { interval: want.cycle === 'monthly' ? 'month' : 'year', frequency: 1 } }),
          ...(quantity ? { quantity } : {}),
          custom_data: { paddle_kit_price: tag },
        })
      ).data;
      note = 'created';
    } else {
      const drift: Json = {};
      if (price.unit_price?.amount !== unitPrice.amount || price.unit_price?.currency_code !== unitPrice.currency_code) {
        drift.unit_price = unitPrice;
      }
      if (quantity && (price.quantity?.minimum !== quantity.minimum || price.quantity?.maximum !== quantity.maximum)) {
        drift.quantity = quantity;
      }
      if (price.name !== want.name) drift.name = want.name;
      if (Object.keys(drift).length) {
        await paddle.call('PATCH', `/prices/${price.id}`, drift);
        note = `updated ${Object.keys(drift).join(', ')}${drift.unit_price ? ` (was ${price.unit_price?.amount})` : ''}`;
      }
    }
    ids[tag] = price!.id;
    rows.push([`price ${tag}`, price!.id, `${(Number(want.amount) / 100).toFixed(2)} ${want.currency}${note ? ` (${note})` : ''}`]);
  }
  put({ PADDLE_ENV: environment, PADDLE_PRICES: JSON.stringify(toPriceMap(catalog, ids)) });

  if (opts.webhookUrl) {
    const url = opts.webhookUrl;
    const settings = await paddle.list('/notification-settings');
    const found = settings.find((d) => d.description === destinationName);
    let secret: unknown;
    if (!found) {
      const created = (
        await paddle.call('POST', '/notification-settings', {
          description: destinationName,
          destination: url,
          type: 'url',
          traffic_source: 'all',
          subscribed_events: EVENTS,
          include_sensitive_fields: false,
        })
      ).data;
      secret = created.endpoint_secret_key;
      rows.push(['destination (created)', created.id, url]);
    } else {
      const drift: Json = {};
      if (found.destination !== url) drift.destination = url;
      if (found.active !== true) drift.active = true;
      if (!sameSet(found.subscribed_events?.map?.((e: any) => (typeof e === 'string' ? e : e?.name)), EVENTS)) {
        drift.subscribed_events = EVENTS;
      }
      if (Object.keys(drift).length) await paddle.call('PATCH', `/notification-settings/${found.id}`, drift);
      rows.push([`destination (existing${Object.keys(drift).length ? ', updated' : ''})`, found.id, url]);
      secret = found.endpoint_secret_key;
    }
    if (typeof secret === 'string' && secret !== '') {
      known.push(secret);
      put({ PADDLE_NOTIFICATION_WEBHOOK_SECRET: secret });
    } else {
      log('Destination returned no secret: copy it from the Paddle dashboard into PADDLE_NOTIFICATION_WEBHOOK_SECRET');
    }

    if (!env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN) {
      const token = (await paddle.call('POST', '/client-tokens', { name: `${catalog.app} (paddle-kit)`, description: 'created by paddle-kit-catalog' })).data;
      if (typeof token?.token === 'string') known.push(token.token);
      if (environment === 'production' && String(token?.token ?? '').startsWith('test_')) {
        throw new PaddleError('Refusing a test_ client token with --live');
      }
      if (typeof token?.token === 'string' && token.token !== '') put({ NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: token.token });
      else log('Paddle returned no client token: create one in the dashboard');
    }
  }

  return done(product!.id, ids);
}

function printTable(log: (line: string) => void, rows: string[][]) {
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => (r[i] ?? '').length), 0));
  for (const r of rows) log(r.map((cell, i) => (cell ?? '').padEnd(widths[i]!)).join('  ').trimEnd());
}
