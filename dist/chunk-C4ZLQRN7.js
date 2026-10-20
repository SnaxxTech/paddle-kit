// src/core/access.ts
var DAY_MS = 864e5;
function grantsAccess(sub, now, graceDays) {
  switch (sub.status) {
    case "active":
    case "trialing":
      return true;
    case "past_due":
      if (!sub.pastDueSince) return true;
      return now.getTime() - Date.parse(sub.pastDueSince) <= graceDays * DAY_MS;
    default:
      return false;
  }
}
function decideAccess(subs, feature, policy, now) {
  return subs.some(
    (s) => grantsAccess(s, now, policy.pastDueGraceDays) && s.priceIds.some((p) => Object.hasOwn(policy.entitlements, p) && policy.entitlements[p].includes(feature))
  );
}
function nextPastDueSince(prev, status, occurredAt) {
  if (status !== "past_due") return null;
  if (prev?.status === "past_due" && prev.pastDueSince) return prev.pastDueSince;
  return occurredAt;
}

// src/core/owns.ts
function ownershipPredicate(owns) {
  if (owns === void 0) return null;
  if (typeof owns === "function") return owns;
  const prices = new Set(owns.priceIds ?? []);
  const products = new Set(owns.productIds ?? []);
  if (prices.size === 0 && products.size === 0) {
    throw new Error("paddle-kit: owns needs at least one priceId or productId (an empty list would ignore every event)");
  }
  return ({ items }) => items.some((i) => prices.has(i.priceId) || i.productId !== null && products.has(i.productId));
}

export {
  decideAccess,
  nextPastDueSince,
  ownershipPredicate
};
