// One product definition (since v0.8.3): what each product unlocks, the prices on sale now (PADDLE_PRICES) and the
// retired prices that still grant while subscriptions on them renew. Entitlements and checkout both read it, so a
// retired price keeps its features without ever being sold again. Pure and edge-safe.
import type { PriceMap } from './index';

export interface ProductDefinition {
  /** Features every price of the product unlocks (`hasAccess(userId, feature)`). */
  features: readonly string[];
  /**
   * Price ids no longer on sale that still grant `features` while subscriptions on them renew (a replaced price, an
   * old plan). They are also owned, so their events are never "not ours". Never offered at checkout.
   */
  retiredPriceIds?: readonly string[];
}

export interface Products {
  /** Price id → features: every price on sale plus every retired one. For `createBilling({ entitlements })`. */
  entitlements: Record<string, readonly string[]>;
  /** Every price id of every product, on sale or retired: for `owns`. */
  priceIds: string[];
  /** The price on sale for `key` (and `cycle` for a cycle map), for checkout. Throws when there is none. */
  checkoutPriceId(key: string, cycle?: string): string;
  /** Which product a price belongs to; `null` for a price of no product. */
  productOf(priceId: string): { key: string; cycle: string | null; retired: boolean } | null;
}

/** Throws (naming the product or price, never a value from the env) when a product has no price on sale. */
export function defineProducts(prices: PriceMap, products: Record<string, ProductDefinition>): Products {
  const entitlements: Record<string, readonly string[]> = {};
  const owner = new Map<string, { key: string; cycle: string | null; retired: boolean }>();
  for (const [key, def] of Object.entries(products)) {
    const entry = prices[key];
    if (entry === undefined) throw new Error(`paddle-kit: PADDLE_PRICES has no "${key}" for products`);
    const onSale: [string | null, string][] = typeof entry === 'string' ? [[null, entry]] : Object.entries(entry);
    for (const [cycle, id] of onSale) {
      entitlements[id] = def.features;
      owner.set(id, { key, cycle, retired: false });
    }
    for (const id of def.retiredPriceIds ?? []) {
      if (owner.get(id)?.retired === false) throw new Error(`paddle-kit: retired price ${id} is on sale (PADDLE_PRICES)`);
      entitlements[id] = def.features;
      owner.set(id, { key, cycle: null, retired: true });
    }
  }
  return {
    entitlements,
    priceIds: [...owner.keys()],
    checkoutPriceId(key, cycle) {
      const entry = key in products ? prices[key] : undefined;
      const id = typeof entry === 'string' ? (cycle === undefined ? entry : undefined) : cycle === undefined ? undefined : entry?.[cycle];
      if (!id) throw new Error(`paddle-kit: no price "${key}"${cycle === undefined ? '' : ` for cycle "${cycle}"`} on sale`);
      return id;
    },
    productOf: (priceId) => owner.get(priceId) ?? null,
  };
}
