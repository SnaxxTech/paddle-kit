import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { billingFromEnv, defineProducts } from '../src/config';
import { memoryStore } from '../src/memory';
import { sign } from './helpers/sign';

// One product definition (since v0.8.3): a product's features, the prices on sale now (from PADDLE_PRICES) and the
// retired prices that still grant while subscriptions on them renew. Checkout reads only the prices on sale.
const PRICES = { pro: { monthly: 'pri_m', yearly: 'pri_y' }, pack: 'pri_pack' };

describe('defineProducts', () => {
  const products = defineProducts(PRICES, {
    pro: { features: ['pro', 'export'], retiredPriceIds: ['pri_m_2025'] },
    pack: { features: [] },
  });

  it('entitlements: every price on sale plus the retired ones, each to the product\'s features', () => {
    expect(products.entitlements).toEqual({
      pri_m: ['pro', 'export'], pri_y: ['pro', 'export'], pri_m_2025: ['pro', 'export'], pri_pack: [],
    });
  });

  it('checkout gets a price on sale, never a retired one', () => {
    expect(products.checkoutPriceId('pro', 'yearly')).toBe('pri_y');
    expect(products.checkoutPriceId('pack')).toBe('pri_pack');
    expect(() => products.checkoutPriceId('pro')).toThrow('no price "pro"');
    expect(() => products.checkoutPriceId('team', 'monthly')).toThrow('no price "team"');
  });

  it('productOf names the product, cycle and whether the price is retired', () => {
    expect(products.productOf('pri_y')).toEqual({ key: 'pro', cycle: 'yearly', retired: false });
    expect(products.productOf('pri_pack')).toEqual({ key: 'pack', cycle: null, retired: false });
    expect(products.productOf('pri_m_2025')).toEqual({ key: 'pro', cycle: null, retired: true });
    expect(products.productOf('pri_other')).toBeNull();
  });

  it('a product with no price on sale is an error naming it; a retired id that is on sale too is refused', () => {
    expect(() => defineProducts(PRICES, { team: { features: ['team'] } })).toThrow('PADDLE_PRICES has no "team"');
    expect(() => defineProducts(PRICES, { pro: { features: ['pro'], retiredPriceIds: ['pri_m'] } })).toThrow('pri_m is on sale');
  });
});

describe('billingFromEnv({ products })', () => {
  const SECRET = 'pdl_ntfset_products';
  const env = {
    PADDLE_ENV: 'sandbox', PADDLE_NOTIFICATION_WEBHOOK_SECRET: SECRET, NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: 'test_products',
    PADDLE_PRICES: JSON.stringify({ pro: { monthly: 'pri_m', yearly: 'pri_y' } }),
  };
  const renewalOn = (price: string) => {
    const raw = JSON.parse(readFileSync(new URL('./fixtures/subscription.created.json', import.meta.url), 'utf8'));
    raw.event_id = `evt_${price}`;
    raw.data.custom_data = { userId: 'u1' };
    raw.data.items = raw.data.items.slice(0, 1).map((i: any) => ({ ...i, price: { ...i.price, id: price } }));
    return JSON.stringify(raw);
  };
  const deliver = (billing: any, body: string) =>
    billing.handleWebhook(new Request('https://app.test/', { method: 'POST', headers: { 'paddle-signature': sign(body, SECRET) }, body }));

  it('before: entitlements built from PADDLE_PRICES alone lose access on a subscription renewing on a retired price', async () => {
    const { billing } = billingFromEnv(env, {
      requiredPrices: ['pro'], store: memoryStore(), log: () => {}, owns: () => true,
      entitlements: (c) => Object.fromEntries(Object.values(c.prices.pro as Record<string, string>).map((id) => [id, ['pro']])),
    });
    expect((await deliver(billing, renewalOn('pri_m_2025'))).status).toBe(200);
    expect(await billing!.hasAccess('u1', 'pro')).toBe(false);
  });

  it('with products: the retired price still grants, is owned, and checkout still sells only the current ones', async () => {
    const { billing, products, problems } = billingFromEnv(env, {
      store: memoryStore(), log: () => {},
      products: { pro: { features: ['pro'], retiredPriceIds: ['pri_m_2025'] } },
    });
    expect(problems).toEqual([]);
    expect((await deliver(billing, renewalOn('pri_m_2025'))).status).toBe(200);
    expect(await billing!.hasAccess('u1', 'pro')).toBe(true);
    expect(products!.checkoutPriceId('pro', 'monthly')).toBe('pri_m');
    expect((await deliver(billing, renewalOn('pri_unrelated'))).status).toBe(200);
    expect((billing!.config.owns as { priceIds: string[] }).priceIds.sort()).toEqual(['pri_m', 'pri_m_2025', 'pri_y']);
  });

  it('a product key missing from PADDLE_PRICES is a named env problem (billing off), never a throw at import', () => {
    const { billing, products, problems } = billingFromEnv(env, { store: memoryStore(), log: () => {}, products: { team: { features: ['team'] } } });
    expect(billing).toBeNull();
    expect(products).toBeNull();
    expect(problems.join(' ')).toContain('team');
  });
});

describe('defineProducts: price ownership does not depend on declaration order (third review)', () => {
  const prices = { basic: 'pri_basic', pro: 'pri_pro' };
  const both = <T>(a: [string, T], b: [string, T]) => [Object.fromEntries([a, b]), Object.fromEntries([b, a])];

  it('a price retired in one product and on sale in another is refused in either order', () => {
    for (const p of both(['basic', { features: ['b'], retiredPriceIds: ['pri_pro'] }], ['pro', { features: ['p'] }])) {
      expect(() => defineProducts(prices, p)).toThrow('pri_pro');
    }
  });

  it('a price on sale in two products is refused in either order, never a silent overwrite of its features', () => {
    for (const p of both(['basic', { features: ['b'] }], ['pro', { features: ['p'] }])) {
      expect(() => defineProducts({ basic: 'pri_same', pro: 'pri_same' }, p)).toThrow('pri_same');
    }
  });

  it('a price retired in two products is refused in either order', () => {
    for (const p of both(['basic', { features: ['b'], retiredPriceIds: ['pri_old'] }], ['pro', { features: ['p'], retiredPriceIds: ['pri_old'] }])) {
      expect(() => defineProducts(prices, p)).toThrow('pri_old');
    }
  });

  it('one product may list the same retired price twice', () => {
    expect(defineProducts(prices, { basic: { features: ['b'], retiredPriceIds: ['pri_old', 'pri_old'] }, pro: { features: ['p'] } }).productOf('pri_old')).toEqual({ key: 'basic', cycle: null, retired: true });
  });
});
