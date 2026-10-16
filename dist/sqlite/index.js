// src/sqlite/index.ts
var SQLITE_MIGRATIONS = [
  {
    name: "001_init",
    sql: `CREATE TABLE IF NOT EXISTS paddle_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS paddle_events_received_at_idx ON paddle_events (received_at);
CREATE TABLE IF NOT EXISTS paddle_failures (
  bucket INTEGER NOT NULL,
  reason TEXT NOT NULL,
  hits INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, reason)
);
CREATE TABLE IF NOT EXISTS paddle_customers (
  customer_id TEXT PRIMARY KEY,
  email TEXT,
  last_event_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS paddle_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  user_id TEXT,
  status TEXT NOT NULL,
  price_ids TEXT NOT NULL,
  current_period_end INTEGER,
  scheduled_change TEXT,
  canceled_at INTEGER,
  past_due_since INTEGER,
  last_event_at INTEGER NOT NULL,
  raw TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS paddle_subscriptions_user_id_idx ON paddle_subscriptions (user_id);
`
  },
  {
    name: "002_claims_transactions",
    sql: `CREATE TABLE IF NOT EXISTS paddle_event_claims (
  event_id TEXT PRIMARY KEY,
  claimed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS paddle_transactions (
  transaction_id TEXT PRIMARY KEY,
  owned INTEGER NOT NULL,
  subscription_id TEXT,
  customer_id TEXT,
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
`
  }
];
var DAY_MS = 864e5;
var DONE = /* @__PURE__ */ new Set(["processed", "ignored", "stale"]);
var ms = (iso2) => iso2 == null ? null : Date.parse(iso2);
var iso = (v) => v == null ? null : new Date(Number(v)).toISOString();
var json = (v) => v == null ? null : JSON.stringify(v);
function toSubscription(r) {
  return {
    subscriptionId: r.subscription_id,
    customerId: r.customer_id,
    userId: r.user_id ?? null,
    status: r.status,
    priceIds: JSON.parse(r.price_ids),
    currentPeriodEnd: iso(r.current_period_end),
    scheduledChange: r.scheduled_change == null ? null : JSON.parse(r.scheduled_change),
    canceledAt: iso(r.canceled_at),
    pastDueSince: iso(r.past_due_since),
    lastEventAt: iso(r.last_event_at),
    raw: JSON.parse(r.raw)
  };
}
function sqliteStore({ db }) {
  const prepared = /* @__PURE__ */ new Map();
  const q = (sql) => {
    let s = prepared.get(sql);
    if (!s) prepared.set(sql, s = db.prepare(sql));
    return s;
  };
  return {
    async recordEvent(e) {
      q(`INSERT INTO paddle_events (event_id, event_type, occurred_at, received_at, status)
         VALUES (?, ?, ?, ?, 'received') ON CONFLICT (event_id) DO NOTHING`).run(
        e.eventId,
        e.eventType,
        ms(e.occurredAt),
        ms(e.receivedAt)
      );
      const row = q(`SELECT status FROM paddle_events WHERE event_id = ?`).get(e.eventId);
      if (DONE.has(row.status)) return { alreadyDone: true };
      if (e.leaseExpiredBefore === void 0) return { alreadyDone: false };
      const claim = q(`INSERT INTO paddle_event_claims (event_id, claimed_at) VALUES (?, ?)
         ON CONFLICT (event_id) DO UPDATE SET claimed_at = excluded.claimed_at
         WHERE paddle_event_claims.claimed_at < ?`).run(e.eventId, ms(e.receivedAt), ms(e.leaseExpiredBefore));
      return claim.changes > 0 ? { alreadyDone: false } : { alreadyDone: false, inProgress: true };
    },
    async markEvent(eventId, status, reason) {
      q(`UPDATE paddle_events SET status = ?, reason = ? WHERE event_id = ?`).run(status, reason, eventId);
      q(`DELETE FROM paddle_event_claims WHERE event_id = ?`).run(eventId);
    },
    async recordFailure(reason, at) {
      const t = at.getTime();
      q(`INSERT INTO paddle_failures (bucket, reason, hits, last_at) VALUES (?, ?, 1, ?)
         ON CONFLICT (bucket, reason) DO UPDATE SET hits = hits + 1, last_at = MAX(last_at, excluded.last_at)`).run(
        Math.floor(t / 6e4) * 6e4,
        reason,
        t
      );
    },
    async upsertCustomer(c) {
      const r = q(`INSERT INTO paddle_customers (customer_id, email, last_event_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (customer_id) DO UPDATE SET email = excluded.email, last_event_at = excluded.last_event_at,
           updated_at = excluded.updated_at
         WHERE paddle_customers.last_event_at <= excluded.last_event_at`).run(
        c.customerId,
        c.email,
        ms(c.lastEventAt),
        Date.now()
      );
      return { applied: r.changes > 0 };
    },
    async upsertSubscription(s) {
      const r = q(`INSERT INTO paddle_subscriptions
           (subscription_id, customer_id, user_id, status, price_ids, current_period_end, scheduled_change,
            canceled_at, past_due_since, last_event_at, raw, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (subscription_id) DO UPDATE SET
           customer_id = excluded.customer_id,
           user_id = COALESCE(excluded.user_id, paddle_subscriptions.user_id),
           status = excluded.status,
           price_ids = excluded.price_ids,
           current_period_end = excluded.current_period_end,
           scheduled_change = excluded.scheduled_change,
           canceled_at = excluded.canceled_at,
           past_due_since = excluded.past_due_since,
           last_event_at = excluded.last_event_at,
           raw = excluded.raw,
           updated_at = excluded.updated_at
         WHERE paddle_subscriptions.last_event_at <= excluded.last_event_at`).run(
        s.subscriptionId,
        s.customerId,
        s.userId,
        s.status,
        JSON.stringify(s.priceIds),
        ms(s.currentPeriodEnd),
        json(s.scheduledChange),
        ms(s.canceledAt),
        ms(s.pastDueSince),
        ms(s.lastEventAt),
        JSON.stringify(s.raw ?? {}),
        Date.now()
      );
      return { applied: r.changes > 0 };
    },
    async recordTransaction(t) {
      q(`INSERT INTO paddle_transactions (transaction_id, owned, subscription_id, customer_id, occurred_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (transaction_id) DO UPDATE SET owned = MAX(paddle_transactions.owned, excluded.owned)`).run(
        t.transactionId,
        t.owned ? 1 : 0,
        t.subscriptionId,
        t.customerId,
        ms(t.occurredAt),
        ms(t.receivedAt)
      );
    },
    async getTransaction(id) {
      const r = q(`SELECT transaction_id, owned FROM paddle_transactions WHERE transaction_id = ?`).get(id);
      return r ? { transactionId: r.transaction_id, owned: Number(r.owned) === 1 } : null;
    },
    async getSubscription(id) {
      const r = q(`SELECT * FROM paddle_subscriptions WHERE subscription_id = ?`).get(id);
      return r ? toSubscription(r) : null;
    },
    async getSubscriptionsByUser(userId) {
      return q(`SELECT * FROM paddle_subscriptions WHERE user_id = ? ORDER BY last_event_at DESC`).all(userId).map(
        toSubscription
      );
    },
    async health(now) {
      const until = now.getTime();
      const since = until - DAY_MS;
      const agg = q(`SELECT
           (SELECT MAX(received_at) FROM paddle_events WHERE status IN ('processed','ignored','stale')) AS last_event_at,
           (SELECT COUNT(*) FROM paddle_events WHERE status = 'failed' AND received_at > ? AND received_at <= ?) AS failed_events,
           (SELECT COALESCE(SUM(hits), 0) FROM paddle_failures WHERE last_at > ? AND last_at <= ?) AS failed_requests,
           (SELECT COUNT(*) FROM paddle_events WHERE reason = 'no_user_id' AND received_at > ? AND received_at <= ?) AS unlinked`).get(
        since,
        until,
        since,
        until,
        since,
        until
      );
      const last = q(`SELECT at, reason FROM (
           SELECT received_at AS at, COALESCE(reason, 'store_error') AS reason FROM paddle_events WHERE status = 'failed'
           UNION ALL SELECT last_at AS at, reason FROM paddle_failures
         ) ORDER BY at DESC LIMIT 1`).get();
      return {
        lastEventAt: iso(agg.last_event_at),
        lastFailureAt: iso(last?.at),
        lastFailureReason: last?.reason ?? null,
        failedLast24h: Number(agg.failed_events) + Number(agg.failed_requests),
        unlinkedLast24h: Number(agg.unlinked)
      };
    }
  };
}
export {
  SQLITE_MIGRATIONS,
  sqliteStore
};
