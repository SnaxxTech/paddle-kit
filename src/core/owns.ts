import type { Owns, OwnsPredicate } from './types';

/** Turns `owns` into one predicate, or null when the app owns everything (no `owns`: a seller account of its own). */
export function ownershipPredicate(owns: Owns | undefined): OwnsPredicate | null {
  if (owns === undefined) return null;
  if (typeof owns === 'function') return owns;
  const prices = new Set(owns.priceIds ?? []);
  const products = new Set(owns.productIds ?? []);
  if (prices.size === 0 && products.size === 0) {
    throw new Error('paddle-kit: owns needs at least one priceId or productId (an empty list would ignore every event)');
  }
  return ({ items }) => items.some((i) => prices.has(i.priceId) || (i.productId !== null && products.has(i.productId)));
}
