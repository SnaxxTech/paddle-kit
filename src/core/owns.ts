import type { OwnedIds, Owns, OwnsPredicate, OwnsResolver } from './types';

export const isOwnsResolver = (owns: Owns | undefined): owns is OwnsResolver =>
  typeof owns === 'object' && owns !== null && typeof (owns as OwnsResolver).resolve === 'function';

/** Turns `owns` into one predicate, or null when the app owns everything (no `owns`: a seller account of its own). */
export function ownershipPredicate(owns: OwnedIds | OwnsPredicate | undefined): OwnsPredicate | null {
  if (owns === undefined) return null;
  if (typeof owns === 'function') return owns;
  const prices = new Set(owns.priceIds ?? []);
  const products = new Set(owns.productIds ?? []);
  if (prices.size === 0 && products.size === 0) {
    throw new Error('paddle-kit: owns needs at least one priceId or productId (an empty list would ignore every event)');
  }
  return ({ items }) => items.some((i) => prices.has(i.priceId) || (i.productId !== null && products.has(i.productId)));
}

/** Like `ownershipPredicate`, awaiting a resolver first. A resolver that fails or finds no id throws: never "owns everything". */
export async function resolveOwnership(owns: Owns | undefined): Promise<OwnsPredicate | null> {
  if (!isOwnsResolver(owns)) return ownershipPredicate(owns);
  return ownershipPredicate((await owns.resolve()) ?? {});
}
