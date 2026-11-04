import {
  jsonValue
} from "../chunk-BI3KW3QN.js";
import {
  missingSchema
} from "../chunk-CNOCPEFW.js";

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
  },
  {
    name: "003_recovery",
    sql: `CREATE TABLE IF NOT EXISTS paddle_recovery (
  name text PRIMARY KEY,
  run_id text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  last_succeeded_at timestamptz,
  checkpoint_at timestamptz,
  lease_until timestamptz,
  reason text
);
CREATE INDEX IF NOT EXISTS paddle_events_unfinished_idx ON paddle_events (received_at)
  WHERE status IN ('received', 'failed');
`
  },
  {
    name: "004_claim_tokens_owned_ids",
    // A new claims table instead of ALTER TABLE: migrations stay CREATE-only. paddle_event_claims is no longer used.
    sql: `CREATE TABLE IF NOT EXISTS paddle_event_leases (
  event_id text PRIMARY KEY,
  claimed_at timestamptz NOT NULL,
  claim_token text
);

CREATE TABLE IF NOT EXISTS paddle_owned_ids (
  id text PRIMARY KEY,
  kind text NOT NULL,
  first_seen_at timestamptz NOT NULL
);
`
  },
  {
    name: "005_fulfilment_outbox",
    // Used only by paddle-kit/fulfil (since v0.8.6); harmless and empty for apps that do not use it. Postgres only.
    sql: `CREATE TABLE IF NOT EXISTS paddle_fulfilments (
  transaction_id text PRIMARY KEY,
  user_id text NOT NULL,
  grants jsonb NOT NULL,
  state text NOT NULL,
  taken jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paddle_fulfilment_adjustments (
  adjustment_id text PRIMARY KEY,
  transaction_id text NOT NULL,
  action text NOT NULL,
  type text,
  status text NOT NULL,
  rank int NOT NULL
);
CREATE INDEX IF NOT EXISTS paddle_fulfilment_adjustments_txn_idx ON paddle_fulfilment_adjustments (transaction_id);

CREATE TABLE IF NOT EXISTS paddle_fulfilment_reviews (
  id text PRIMARY KEY,
  transaction_id text NOT NULL,
  kind text NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE IF NOT EXISTS paddle_outbox (
  id text PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paddle_outbox_due_idx ON paddle_outbox (next_at) WHERE sent_at IS NULL;
`
  },
  {
    name: "006_recovery_progress",
    // CREATE-only: where an interrupted recovery run stopped, so the next run continues its window (since v0.8.7).
    sql: `CREATE TABLE IF NOT EXISTS paddle_recovery_progress (
  name text PRIMARY KEY,
  run_id text NOT NULL,
  window_from timestamptz NOT NULL,
  window_to timestamptz NOT NULL,
  phase text NOT NULL,
  cursor text,
  updated_at timestamptz NOT NULL DEFAULT now()
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
    priceIds: jsonValue(r.price_ids),
    currentPeriodEnd: iso(r.current_period_end),
    scheduledChange: jsonValue(r.scheduled_change) ?? null,
    canceledAt: iso(r.canceled_at),
    pastDueSince: iso(r.past_due_since),
    lastEventAt: iso(r.last_event_at),
    raw: jsonValue(r.raw)
  };
}
function postgresStore({ query }) {
  async function writeSubscription(s, deriveGrace = false) {
    const { rows } = await query(
      `INSERT INTO paddle_subscriptions
         (subscription_id, customer_id, user_id, status, price_ids, current_period_end, scheduled_change,
          canceled_at, past_due_since, last_event_at, raw)
       VALUES ($1, $2, $3, $4, $5::text::jsonb, ${ms(6)}, $7::text::jsonb, ${ms(8)}, ${ms(9)}, ${ms(10)}, $11::text::jsonb)
       ON CONFLICT (subscription_id) DO UPDATE SET
         customer_id = EXCLUDED.customer_id,
         user_id = COALESCE(EXCLUDED.user_id, paddle_subscriptions.user_id),
         status = EXCLUDED.status,
         price_ids = EXCLUDED.price_ids,
         current_period_end = EXCLUDED.current_period_end,
         scheduled_change = EXCLUDED.scheduled_change,
         canceled_at = EXCLUDED.canceled_at,
         past_due_since = CASE WHEN $12::boolean THEN
           CASE WHEN EXCLUDED.status <> 'past_due' THEN NULL
             WHEN paddle_subscriptions.status = 'past_due' THEN COALESCE(paddle_subscriptions.past_due_since, EXCLUDED.last_event_at)
             ELSE EXCLUDED.last_event_at END
           ELSE EXCLUDED.past_due_since END,
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
        jsonParam(s.raw ?? {}),
        deriveGrace
      ]
    );
    return { applied: rows.length > 0 };
  }
  return {
    recovery: {
      async getRecovery(name) {
        const { rows: [r] } = await query("SELECT * FROM paddle_recovery WHERE name = $1", [name]);
        return r ? {
          name: r.name,
          runId: r.run_id,
          status: r.status,
          startedAt: iso(r.started_at),
          finishedAt: iso(r.finished_at),
          lastSucceededAt: iso(r.last_succeeded_at),
          checkpointAt: iso(r.checkpoint_at),
          leaseUntil: iso(r.lease_until),
          reason: r.reason
        } : null;
      },
      async claimRecovery(e) {
        const { rows } = await query(`INSERT INTO paddle_recovery (name, run_id, status, started_at, lease_until)
          VALUES ($1, $2, 'running', ${ms(3)}, ${ms(4)})
          ON CONFLICT (name) DO UPDATE SET run_id = EXCLUDED.run_id, status = 'running', started_at = EXCLUDED.started_at,
            lease_until = EXCLUDED.lease_until, finished_at = NULL, reason = NULL
          WHERE paddle_recovery.lease_until IS NULL OR paddle_recovery.lease_until <= EXCLUDED.started_at
          RETURNING name`, [e.name, e.runId, e.startedAt, e.leaseUntil]);
        return rows.length > 0;
      },
      async finishRecovery(e) {
        const { rows } = await query(`UPDATE paddle_recovery SET status = $3, finished_at = ${ms(4)}, lease_until = NULL, reason = $5,
          last_succeeded_at = CASE WHEN $3 = 'succeeded' THEN ${ms(4)} ELSE last_succeeded_at END,
          checkpoint_at = CASE WHEN $3 = 'succeeded' THEN COALESCE(${ms(6)}, started_at) ELSE checkpoint_at END
          WHERE name = $1 AND run_id = $2 AND status = 'running' RETURNING name`, [e.name, e.runId, e.status, e.finishedAt, e.reason, e.checkpointAt ?? null]);
        return rows.length > 0;
      },
      async getRecoveryProgress(name) {
        const { rows: [r] } = await query("SELECT * FROM paddle_recovery_progress WHERE name = $1", [name]);
        return r ? { from: iso(r.window_from), to: iso(r.window_to), phase: r.phase, cursor: r.cursor ?? null } : null;
      },
      async saveRecoveryProgress({ name, runId, progress: p }) {
        const lease = `EXISTS (SELECT 1 FROM paddle_recovery WHERE name = $1 AND run_id = $2 AND status = 'running')`;
        if (!p) return (await query(`WITH d AS (DELETE FROM paddle_recovery_progress WHERE name = $1 AND ${lease}) SELECT ${lease} AS ok`, [name, runId])).rows[0]?.ok === true;
        const { rows } = await query(`INSERT INTO paddle_recovery_progress (name, run_id, window_from, window_to, phase, cursor, updated_at)
          SELECT $1, $2, ${ms(3)}, ${ms(4)}, $5, $6, now() WHERE ${lease}
          ON CONFLICT (name) DO UPDATE SET run_id = EXCLUDED.run_id, window_from = EXCLUDED.window_from, window_to = EXCLUDED.window_to,
            phase = EXCLUDED.phase, cursor = EXCLUDED.cursor, updated_at = EXCLUDED.updated_at
          RETURNING name`, [name, runId, p.from, p.to, p.phase, p.cursor]);
        return rows.length > 0;
      },
      async getPendingEvents(e) {
        const { rows } = await query(`SELECT e.event_id, e.event_type, e.occurred_at FROM paddle_events e WHERE e.status IN ('received','failed')
          AND e.received_at <= $1 AND NOT EXISTS (SELECT 1 FROM paddle_event_leases c WHERE c.event_id = e.event_id AND c.claimed_at > $1)
          ORDER BY e.received_at, e.event_id LIMIT $2`, [e.before, e.limit]);
        return rows.map((r) => ({ eventId: r.event_id, eventType: r.event_type, occurredAt: iso(r.occurred_at) }));
      }
    },
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
        `INSERT INTO paddle_event_leases (event_id, claimed_at, claim_token) VALUES ($1, ${ms(2)}, $4)
         ON CONFLICT (event_id) DO UPDATE SET claimed_at = EXCLUDED.claimed_at, claim_token = EXCLUDED.claim_token
           WHERE paddle_event_leases.claimed_at < $3::timestamptz
         RETURNING event_id`,
        [e.eventId, e.receivedAt, e.leaseExpiredBefore, e.claimToken ?? null]
      );
      if (claim.rows.length === 0) return { alreadyDone: false, inProgress: true };
      const { rows: [now] } = await query(`SELECT status FROM paddle_events WHERE event_id = $1`, [e.eventId]);
      if (isDone(now?.status)) {
        await query(`DELETE FROM paddle_event_leases WHERE event_id = $1`, [e.eventId]);
        return { alreadyDone: true };
      }
      return { alreadyDone: false };
    },
    async markEvent(eventId, status, reason, claimToken) {
      if (claimToken === void 0) {
        await query(`UPDATE paddle_events SET status = $2, reason = $3 WHERE event_id = $1`, [eventId, status, reason]);
        await query(`DELETE FROM paddle_event_leases WHERE event_id = $1`, [eventId]);
        return;
      }
      const { rows } = await query(
        `WITH released AS (DELETE FROM paddle_event_leases WHERE event_id = $1 AND claim_token = $4 RETURNING event_id)
         UPDATE paddle_events SET status = $2, reason = $3 WHERE event_id = (SELECT event_id FROM released) RETURNING event_id`,
        [eventId, status, reason, claimToken]
      );
      return rows.length > 0;
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
    upsertSubscription: writeSubscription,
    applySubscription: (s) => writeSubscription({ ...s, pastDueSince: s.status === "past_due" ? s.lastEventAt : null }, true),
    async recordTransaction(t) {
      await query(
        `INSERT INTO paddle_transactions (transaction_id, owned, subscription_id, customer_id, occurred_at, received_at)
         VALUES ($1, $2, $3, $4, ${ms(5)}, ${ms(6)})
         ON CONFLICT (transaction_id) DO UPDATE SET owned = paddle_transactions.owned OR EXCLUDED.owned`,
        [t.transactionId, t.owned, t.subscriptionId, t.customerId, t.occurredAt, t.receivedAt]
      );
    },
    async addOwnedIds(ids, at) {
      const rows = [...ids.priceIds.map((id) => ({ id, kind: "price" })), ...ids.productIds.map((id) => ({ id, kind: "product" }))];
      if (rows.length === 0) return;
      await query(
        `INSERT INTO paddle_owned_ids (id, kind, first_seen_at)
         SELECT x.id, x.kind, ${ms(2)} FROM jsonb_to_recordset($1::text::jsonb) AS x(id text, kind text)
         ON CONFLICT (id) DO NOTHING`,
        [jsonParam(rows), at]
      );
    },
    async checkSchema(extra) {
      const { rows } = await query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name LIKE 'paddle\\_%'`
      );
      const found = /* @__PURE__ */ new Map();
      for (const r of rows) {
        const t = r.table_name;
        if (!found.has(t)) found.set(t, /* @__PURE__ */ new Set());
        found.get(t).add(r.column_name);
      }
      return { missing: missingSchema(found, extra) };
    },
    async getOwnedIds() {
      const { rows } = await query(`SELECT id, kind FROM paddle_owned_ids ORDER BY id`);
      return {
        priceIds: rows.filter((r) => r.kind === "price").map((r) => r.id),
        productIds: rows.filter((r) => r.kind === "product").map((r) => r.id)
      };
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
           (SELECT count(*)::int FROM paddle_events WHERE reason = 'not_ours' AND received_at > $1 AND received_at <= $2) AS not_ours,
           (SELECT count(*)::int FROM paddle_events WHERE status = 'failed') AS unresolved_failed,
           (SELECT min(received_at) FROM paddle_events WHERE status = 'received') AS oldest_pending`,
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
        unresolvedFailed: Number(agg?.unresolved_failed ?? 0),
        oldestPendingAt: iso(agg?.oldest_pending),
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
