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

export {
  decideAccess,
  nextPastDueSince
};
