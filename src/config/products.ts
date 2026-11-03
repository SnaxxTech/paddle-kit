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
  // Every assignment first, then the maps: ownership must not depend on the order products are declared in.
  const assigned: { id: string; key: string; cycle: string | null; retired: boolean }[] = [];
  for (const [key, def] of Object.entries(products)) {
    const entry = prices[key];
    if (entry === undefined) throw new Error(`paddle-kit: PADDLE_PRICES has no "${key}" for products`);
    const onSale: [string | null, string][] = typeof entry === 'string' ? [[null, entry]] : Object.entries(entry);
    for (const [cycle, id] of onSale) assigned.push({ id, key, cycle, retired: false });
    for (const id of new Set(def.retiredPriceIds ?? [])) assigned.push({ id, key, cycle: null, retired: true });
  }
  const entitlements: Record<string, readonly string[]> = {};
  const owner = new Map<string, { key: string; cycle: string | null; retired: boolean }>();
  for (const { id, ...o } of assigned) {
    const first = owner.get(id);
    if (first && first.retired !== o.retired) throw new Error(`paddle-kit: retired price ${id} is on sale (PADDLE_PRICES)`);
    if (first && first.key !== o.key) throw new Error(`paddle-kit: price ${id} belongs to two products ("${first.key}", "${o.key}")`);
    if (first) continue; // the same product's price under two cycles keeps its first cycle
    entitlements[id] = products[o.key]!.features;
    owner.set(id, o);
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
