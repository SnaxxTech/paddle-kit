// src/plan/index.ts
var DAY = 864e5;
function planOf(i) {
  if (i.exempt) return { kind: "free" };
  if (i.subscribed) return { kind: "paid" };
  const from = i.launchAt === null ? i.startedAt : Math.max(i.startedAt, i.launchAt);
  const days = Number.isFinite(i.trialDays) && i.trialDays > 0 ? i.trialDays : 0;
  if (days === 0) return { kind: "expired", endedAt: from };
  const endsAt = from + days * DAY;
  if (i.now < endsAt) return { kind: "trial", endsAt, daysLeft: Math.ceil((endsAt - i.now) / DAY) };
  return { kind: "expired", endedAt: endsAt };
}
export {
  planOf
};
