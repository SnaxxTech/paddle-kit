import type { Customer, EventStatus, Health, ReasonCode, Store, Subscription, RecoveryState } from '../core/types';

interface EventRow { eventId: string; eventType: string; occurredAt: string; receivedAt: string; status: EventStatus; reason: ReasonCode | null }
interface FailureHit { at: string; reason: ReasonCode }

const DAY_MS = 86_400_000;
const DONE: ReadonlySet<EventStatus> = new Set(['processed', 'ignored', 'stale']);

export function memoryStore(): Store {
  const events = new Map<string, EventRow>();
  const failures: FailureHit[] = [];
  const subs = new Map<string, Subscription>();
  const customers = new Map<string, Customer>();
  const claims = new Map<string, { at: string; token?: string }>(); // eventId -> claim
  const recoveries = new Map<string, RecoveryState>();
  const transactions = new Map<string, boolean>(); // transactionId -> owned

  return {
    async recordEvent(e) {
      const existing = events.get(e.eventId);
      if (existing && DONE.has(existing.status)) return { alreadyDone: true };
      if (!existing) events.set(e.eventId, { eventId: e.eventId, eventType: e.eventType, occurredAt: e.occurredAt, receivedAt: e.receivedAt, status: 'received', reason: null });
      if (e.leaseExpiredBefore === undefined) return { alreadyDone: false };
      const held = claims.get(e.eventId);
      if (held !== undefined && Date.parse(held.at) >= Date.parse(e.leaseExpiredBefore)) return { alreadyDone: false, inProgress: true };
      claims.set(e.eventId, { at: e.receivedAt, token: e.claimToken });
      return { alreadyDone: false };
    },
    async markEvent(eventId, status, reason, claimToken) {
      if (claimToken !== undefined && claims.get(eventId)?.token !== claimToken) return false;
      const row = events.get(eventId);
      if (row) Object.assign(row, { status, reason });
      claims.delete(eventId);
      return true;
    },
    async recordFailure(reason, at) {
      failures.push({ at: at.toISOString(), reason });
    },
    async upsertCustomer(c) {
      const prev = customers.get(c.customerId);
      if (prev && Date.parse(prev.lastEventAt) > Date.parse(c.lastEventAt)) return { applied: false };
      customers.set(c.customerId, structuredClone(c));
      return { applied: true };
    },
    async upsertSubscription(s) {
      const prev = subs.get(s.subscriptionId);
      if (prev && Date.parse(prev.lastEventAt) > Date.parse(s.lastEventAt)) return { applied: false };
      subs.set(s.subscriptionId, structuredClone({ ...s, userId: s.userId ?? prev?.userId ?? null }));
      return { applied: true };
    },
    async applySubscription(s) {
      const prev = subs.get(s.subscriptionId);
      if (prev && Date.parse(prev.lastEventAt) > Date.parse(s.lastEventAt)) return { applied: false };
      const pastDueSince = s.status !== 'past_due' ? null
        : prev?.status === 'past_due' ? prev.pastDueSince ?? s.lastEventAt : s.lastEventAt;
      subs.set(s.subscriptionId, structuredClone({ ...s, userId: s.userId ?? prev?.userId ?? null, pastDueSince }));
      return { applied: true };
    },
    recovery: {
      async getRecovery(name) { return structuredClone(recoveries.get(name) ?? null); },
      async claimRecovery(input) {
        const prev = recoveries.get(input.name);
        if (prev?.leaseUntil && Date.parse(prev.leaseUntil) > Date.parse(input.startedAt)) return false;
        recoveries.set(input.name, { ...input, status: 'running', finishedAt: null, reason: null,
          lastSucceededAt: prev?.lastSucceededAt ?? null, checkpointAt: prev?.checkpointAt ?? null });
        return true;
      },
      async finishRecovery(input) {
        const prev = recoveries.get(input.name);
        if (!prev || prev.runId !== input.runId || prev.status !== 'running') return false;
        recoveries.set(input.name, { ...prev, ...input, leaseUntil: null,
          lastSucceededAt: input.status === 'succeeded' ? input.finishedAt : prev.lastSucceededAt,
          checkpointAt: input.status === 'succeeded' ? prev.startedAt : prev.checkpointAt });
        return true;
      },
      async getPendingEvents({ before, limit }) {
        return [...events.values()].filter(e => (e.status === 'received' || e.status === 'failed')
          && Date.parse(e.receivedAt) <= Date.parse(before)
          && (!claims.has(e.eventId) || Date.parse(claims.get(e.eventId)!.at) <= Date.parse(before)))
          .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt) || a.eventId.localeCompare(b.eventId))
          .slice(0, limit).map(({ eventId, eventType, occurredAt }) => ({ eventId, eventType, occurredAt }));
      },
    },
    async recordTransaction(t) {
      transactions.set(t.transactionId, (transactions.get(t.transactionId) ?? false) || t.owned);
    },
    async getTransaction(id) {
      const owned = transactions.get(id);
      return owned === undefined ? null : { transactionId: id, owned };
    },
    async getSubscription(id) {
      const s = subs.get(id);
      return s ? structuredClone(s) : null;
    },
    async getSubscriptionsByUser(userId) {
      return [...subs.values()]
        .filter((s) => s.userId === userId)
        .sort((a, b) => Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt))
        .map((x) => structuredClone(x));
    },
    async health(now): Promise<Health> {
      const since = now.getTime() - DAY_MS;
      const inWindow = (iso: string) => Date.parse(iso) > since && Date.parse(iso) <= now.getTime();
      const rows = [...events.values()];
      const done = rows.filter((r) => DONE.has(r.status)).map((r) => r.receivedAt).sort((a, b) => Date.parse(a) - Date.parse(b));
      const fails: FailureHit[] = [
        ...rows.filter((r) => r.status === 'failed').map((r) => ({ at: r.receivedAt, reason: r.reason ?? 'store_error' as ReasonCode })),
        ...failures,
      ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const last = fails.at(-1);
      const owned = rows.filter((r) => r.status === 'processed' && (r.reason === null || r.reason === 'no_user_id')).map((r) => r.receivedAt).sort((a, b) => Date.parse(a) - Date.parse(b));
      return {
        lastEventAt: done.at(-1) ?? null,
        lastFailureAt: last?.at ?? null,
        lastFailureReason: last?.reason ?? null,
        failedLast24h: fails.filter((f) => inWindow(f.at)).length,
        unlinkedLast24h: rows.filter((r) => r.reason === 'no_user_id' && inWindow(r.receivedAt)).length,
        lastOwnedAt: owned.at(-1) ?? null,
        unresolvedFailed: rows.filter(r => r.status === 'failed').length,
        oldestPendingAt: rows.filter(r => r.status === 'received').map(r => r.receivedAt).sort((a,b) => Date.parse(a)-Date.parse(b))[0] ?? null,
        notOursLast24h: rows.filter((r) => r.reason === 'not_ours' && inWindow(r.receivedAt)).length,
      };
    },
  };
}
