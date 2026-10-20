// src/postgres/migrations.ts
var MIGRATIONS = [
  {
    name: "001_init",
    sql: `CREATE TABLE IF NOT EXISTS paddle_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  status text NOT NULL,
  reason text
);
CREATE INDEX IF NOT EXISTS paddle_events_received_at_idx ON paddle_events (received_at);

CREATE TABLE IF NOT EXISTS paddle_failures (
  bucket timestamptz NOT NULL,
  reason text NOT NULL,
  hits integer NOT NULL,
  last_at timestamptz NOT NULL,
  PRIMARY KEY (bucket, reason)
);

CREATE TABLE IF NOT EXISTS paddle_customers (
  customer_id text PRIMARY KEY,
  email text,
  last_event_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paddle_subscriptions (
  subscription_id text PRIMARY KEY,
  customer_id text NOT NULL,
  user_id text,
  status text NOT NULL,
  price_ids jsonb NOT NULL,
  current_period_end timestamptz,
  scheduled_change jsonb,
  canceled_at timestamptz,
  past_due_since timestamptz,
  last_event_at timestamptz NOT NULL,
  raw jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paddle_subscriptions_user_id_idx ON paddle_subscriptions (user_id);
`
  },
  {
    name: "002_claims_transactions",
    sql: `CREATE TABLE IF NOT EXISTS paddle_event_claims (
  event_id text PRIMARY KEY,
  claimed_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS paddle_transactions (
  transaction_id text PRIMARY KEY,
  owned boolean NOT NULL,
  subscription_id text,
  customer_id text,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL
);
`
  }
];

// src/postgres/index.ts
var iso = (v) => v == null ? null : new Date(v).toISOString();
var jsonParam = (v) => v == null ? null : JSON.stringify(v).replace(/\\\\|\\u0000/g, (m) => m === "\\\\" ? m : "");
var ms = (n) => `date_trunc('milliseconds', $${n}::timestamptz)`;
var DAY_MS = 864e5;
var isDone = (s) => s === "processed" || s === "ignored" || s === "stale";
function toSubscription(r) {
  return {
    subscriptionId: r.subscription_id,
    customerId: r.customer_id,
    userId: r.user_id ?? null,
    status: r.status,
    priceIds: r.price_ids,
    currentPeriodEnd: iso(r.current_period_end),
    scheduledChange: r.scheduled_change ?? null,
    canceledAt: iso(r.canceled_at),
    pastDueSince: iso(r.past_due_since),
    lastEventAt: iso(r.last_event_at),
    raw: r.raw
  };
}
function postgresStore({ query }) {
  return {
    async recordEvent(e) {
      const { rows } = await query(
        `INSERT INTO paddle_events (event_id, event_type, occurred_at, received_at, status)
         VALUES ($1, $2, ${ms(3)}, ${ms(4)}, 'received')
         ON CONFLICT (event_id) DO UPDATE SET event_id = paddle_events.event_id -- no-op so RETURNING yields the stored row
         RETURNING status`,
        [e.eventId, e.eventType, e.occurredAt, e.receivedAt]
      );
      if (isDone(rows[0]?.status)) return { alreadyDone: true };
      if (e.leaseExpiredBefore === void 0) return { alreadyDone: false };
      const claim = await query(
        `INSERT INTO paddle_event_claims (event_id, claimed_at) VALUES ($1, ${ms(2)})
         ON CONFLICT (event_id) DO UPDATE SET claimed_at = EXCLUDED.claimed_at
           WHERE paddle_event_claims.claimed_at < $3::timestamptz
         RETURNING event_id`,
        [e.eventId, e.receivedAt, e.leaseExpiredBefore]
      );
      if (claim.rows.length === 0) return { alreadyDone: false, inProgress: true };
      const { rows: [now] } = await query(`SELECT status FROM paddle_events WHERE event_id = $1`, [e.eventId]);
      if (isDone(now?.status)) {
        await query(`DELETE FROM paddle_event_claims WHERE event_id = $1`, [e.eventId]);
        return { alreadyDone: true };
      }
      return { alreadyDone: false };
    },
    async markEvent(eventId, status, reason) {
      await query(`UPDATE paddle_events SET status = $2, reason = $3 WHERE event_id = $1`, [eventId, status, reason]);
      await query(`DELETE FROM paddle_event_claims WHERE event_id = $1`, [eventId]);
    },
    async recordFailure(reason, at) {
      await query(
        `INSERT INTO paddle_failures (bucket, reason, hits, last_at)
         VALUES (date_trunc('minute', $1::timestamptz), $2, 1, ${ms(1)})
         ON CONFLICT (bucket, reason) DO UPDATE
           SET hits = paddle_failures.hits + 1, last_at = GREATEST(paddle_failures.last_at, EXCLUDED.last_at)`,
        [at.toISOString(), reason]
      );
    },
    async upsertCustomer(c) {
      const { rows } = await query(
        `INSERT INTO paddle_customers (customer_id, email, last_event_at) VALUES ($1, $2, ${ms(3)})
         ON CONFLICT (customer_id) DO UPDATE
           SET email = EXCLUDED.email, last_event_at = EXCLUDED.last_event_at, updated_at = now()
           WHERE paddle_customers.last_event_at <= EXCLUDED.last_event_at
         RETURNING customer_id`,
        [c.customerId, c.email, c.lastEventAt]
      );
      return { applied: rows.length > 0 };
    },
    async upsertSubscription(s) {
      const { rows } = await query(
        `INSERT INTO paddle_subscriptions
           (subscription_id, customer_id, user_id, status, price_ids, current_period_end, scheduled_change,
            canceled_at, past_due_since, last_event_at, raw)
         VALUES ($1, $2, $3, $4, $5::jsonb, ${ms(6)}, $7::jsonb, ${ms(8)}, ${ms(9)}, ${ms(10)}, $11::jsonb)
         ON CONFLICT (subscription_id) DO UPDATE SET
           customer_id = EXCLUDED.customer_id,
           user_id = COALESCE(EXCLUDED.user_id, paddle_subscriptions.user_id),
           status = EXCLUDED.status,
           price_ids = EXCLUDED.price_ids,
           current_period_end = EXCLUDED.current_period_end,
           scheduled_change = EXCLUDED.scheduled_change,
           canceled_at = EXCLUDED.canceled_at,
           past_due_since = EXCLUDED.past_due_since,
           last_event_at = EXCLUDED.last_event_at,
           raw = EXCLUDED.raw,
           updated_at = now()
         WHERE paddle_subscriptions.last_event_at <= EXCLUDED.last_event_at
         RETURNING subscription_id`,
        [
          s.subscriptionId,
          s.customerId,
          s.userId,
          s.status,
          jsonParam(s.priceIds),
          s.currentPeriodEnd,
          jsonParam(s.scheduledChange),
          s.canceledAt,
          s.pastDueSince,
          s.lastEventAt,
          jsonParam(s.raw ?? {})
        ]
      );
      return { applied: rows.length > 0 };
    },
    async recordTransaction(t) {
      await query(
        `INSERT INTO paddle_transactions (transaction_id, owned, subscription_id, customer_id, occurred_at, received_at)
         VALUES ($1, $2, $3, $4, ${ms(5)}, ${ms(6)})
         ON CONFLICT (transaction_id) DO UPDATE SET owned = paddle_transactions.owned OR EXCLUDED.owned`,
        [t.transactionId, t.owned, t.subscriptionId, t.customerId, t.occurredAt, t.receivedAt]
      );
    },
    async getTransaction(id) {
      const { rows } = await query(`SELECT transaction_id, owned FROM paddle_transactions WHERE transaction_id = $1`, [id]);
      return rows[0] ? { transactionId: rows[0].transaction_id, owned: rows[0].owned === true } : null;
    },
    async getSubscription(id) {
      const { rows } = await query(`SELECT * FROM paddle_subscriptions WHERE subscription_id = $1`, [id]);
      return rows[0] ? toSubscription(rows[0]) : null;
    },
    async getSubscriptionsByUser(userId) {
      const { rows } = await query(`SELECT * FROM paddle_subscriptions WHERE user_id = $1 ORDER BY last_event_at DESC`, [userId]);
      return rows.map(toSubscription);
    },
    async health(now) {
      const since = new Date(now.getTime() - DAY_MS).toISOString();
      const until = now.toISOString();
      const { rows: [agg] } = await query(
        `SELECT
           (SELECT max(received_at) FROM paddle_events WHERE status IN ('processed','ignored','stale')) AS last_event_at,
           (SELECT count(*)::int FROM paddle_events WHERE status = 'failed' AND received_at > $1 AND received_at <= $2) AS failed_events,
           (SELECT coalesce(sum(hits), 0)::int FROM paddle_failures WHERE last_at > $1 AND last_at <= $2) AS failed_requests,
           (SELECT count(*)::int FROM paddle_events WHERE reason = 'no_user_id' AND received_at > $1 AND received_at <= $2) AS unlinked,
           (SELECT max(received_at) FROM paddle_events WHERE status = 'processed' AND (reason IS NULL OR reason = 'no_user_id')) AS last_owned_at,
           (SELECT count(*)::int FROM paddle_events WHERE reason = 'not_ours' AND received_at > $1 AND received_at <= $2) AS not_ours`,
        [since, until]
      );
      const { rows: [last] } = await query(
        `SELECT at, coalesce(reason, 'store_error') AS reason FROM (
           SELECT received_at AS at, reason FROM paddle_events WHERE status = 'failed'
           UNION ALL
           SELECT last_at AS at, reason FROM paddle_failures
         ) f ORDER BY at DESC LIMIT 1`
      );
      return {
        lastEventAt: iso(agg?.last_event_at),
        lastFailureAt: iso(last?.at),
        lastFailureReason: last?.reason ?? null,
        failedLast24h: Number(agg?.failed_events ?? 0) + Number(agg?.failed_requests ?? 0),
        unlinkedLast24h: Number(agg?.unlinked ?? 0),
        lastOwnedAt: iso(agg?.last_owned_at),
        notOursLast24h: Number(agg?.not_ours ?? 0)
      };
    }
  };
}
export {
  MIGRATIONS,
  postgresStore
};
