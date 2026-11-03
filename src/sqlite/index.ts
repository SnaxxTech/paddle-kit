import type { Customer, EventStatus, Health, ReasonCode, Store, Subscription, RecoveryState } from '../core/types';

/** The subset of better-sqlite3 this store uses; any compatible driver works. */
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
}

// Timestamps are INTEGER epoch milliseconds, so comparisons order instants.
export const SQLITE_MIGRATIONS: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: '001_init',
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
`,
  },
  {
    name: '002_claims_transactions',
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
`,
  },
  {
    name: '003_recovery',
    sql: `CREATE TABLE IF NOT EXISTS paddle_recovery (
  name TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL,
  finished_at INTEGER, last_succeeded_at INTEGER, checkpoint_at INTEGER, lease_until INTEGER, reason TEXT
);
CREATE INDEX IF NOT EXISTS paddle_events_unfinished_idx ON paddle_events (received_at) WHERE status IN ('received','failed');`,
  },
  {
    name: '004_claim_tokens_owned_ids',
    // A new claims table, not ALTER TABLE: SQLite has no ADD COLUMN IF NOT EXISTS, and these migrations rerun at startup.
    // paddle_event_claims is no longer used (a claim lives ~a minute: nothing to copy).
    sql: `CREATE TABLE IF NOT EXISTS paddle_event_leases (
  event_id TEXT PRIMARY KEY,
  claimed_at INTEGER NOT NULL,
  claim_token TEXT
);`,
  },
];

const DAY_MS = 86_400_000;
const DONE: ReadonlySet<string> = new Set(['processed', 'ignored', 'stale']);
const ms = (iso: string | null): number | null => (iso == null ? null : Date.parse(iso));
const iso = (v: unknown): string | null => (v == null ? null : new Date(Number(v)).toISOString());
const json = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

type Row = Record<string, unknown>;

function toSubscription(r: Row): Subscription {
  return {
    subscriptionId: r.subscription_id as string,
    customerId: r.customer_id as string,
    userId: (r.user_id as string | null) ?? null,
    status: r.status as Subscription['status'],
    priceIds: JSON.parse(r.price_ids as string),
    currentPeriodEnd: iso(r.current_period_end),
    scheduledChange: r.scheduled_change == null ? null : JSON.parse(r.scheduled_change as string),
    canceledAt: iso(r.canceled_at),
    pastDueSince: iso(r.past_due_since),
    lastEventAt: iso(r.last_event_at)!,
    raw: JSON.parse(r.raw as string),
  };
}

export function sqliteStore({ db }: { db: SqliteDatabase }): Store {
  const prepared = new Map<string, SqliteStatement>();
  const q = (sql: string) => {
    let s = prepared.get(sql);
    if (!s) prepared.set(sql, (s = db.prepare(sql)));
    return s;
  };

  async function writeSubscription(s: Subscription, deriveGrace = false) {
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
         past_due_since = CASE WHEN ? THEN
           CASE WHEN excluded.status <> 'past_due' THEN NULL
             WHEN paddle_subscriptions.status = 'past_due' THEN COALESCE(paddle_subscriptions.past_due_since, excluded.last_event_at)
             ELSE excluded.last_event_at END
           ELSE excluded.past_due_since END,
         last_event_at = excluded.last_event_at,
         raw = excluded.raw,
         updated_at = excluded.updated_at
       WHERE paddle_subscriptions.last_event_at <= excluded.last_event_at`).run(
      s.subscriptionId, s.customerId, s.userId, s.status, JSON.stringify(s.priceIds), ms(s.currentPeriodEnd),
      json(s.scheduledChange), ms(s.canceledAt), ms(s.pastDueSince), ms(s.lastEventAt), JSON.stringify(s.raw ?? {}),
      Date.now(), deriveGrace ? 1 : 0,
    );
    return { applied: r.changes > 0 };
  }
  return {
    recovery: {
      async getRecovery(name) {
        const r = q('SELECT * FROM paddle_recovery WHERE name = ?').get(name) as Row | undefined;
        return r ? { name: r.name as string, runId: r.run_id as string, status: r.status as RecoveryState['status'],
          startedAt: iso(r.started_at)!, finishedAt: iso(r.finished_at), lastSucceededAt: iso(r.last_succeeded_at),
          checkpointAt: iso(r.checkpoint_at), leaseUntil: iso(r.lease_until), reason: r.reason as RecoveryState['reason'] } : null;
      },
      async claimRecovery(e) {
        return q(`INSERT INTO paddle_recovery (name, run_id, status, started_at, lease_until) VALUES (?, ?, 'running', ?, ?)
          ON CONFLICT (name) DO UPDATE SET run_id = excluded.run_id, status = 'running', started_at = excluded.started_at,
            lease_until = excluded.lease_until, finished_at = NULL, reason = NULL
          WHERE paddle_recovery.lease_until IS NULL OR paddle_recovery.lease_until <= excluded.started_at`)
          .run(e.name, e.runId, ms(e.startedAt), ms(e.leaseUntil)).changes > 0;
      },
      async finishRecovery(e) {
        return q(`UPDATE paddle_recovery SET status = ?, finished_at = ?, lease_until = NULL, reason = ?,
          last_succeeded_at = CASE WHEN ? = 'succeeded' THEN ? ELSE last_succeeded_at END,
          checkpoint_at = CASE WHEN ? = 'succeeded' THEN started_at ELSE checkpoint_at END
          WHERE name = ? AND run_id = ? AND status = 'running'`)
          .run(e.status, ms(e.finishedAt), e.reason, e.status, ms(e.finishedAt), e.status, e.name, e.runId).changes > 0;
      },
      async getPendingEvents(e) {
        return (q(`SELECT e.event_id, e.event_type, e.occurred_at FROM paddle_events e WHERE e.status IN ('received','failed') AND e.received_at <= ?
          AND NOT EXISTS (SELECT 1 FROM paddle_event_leases c WHERE c.event_id = e.event_id AND c.claimed_at > ?)
          ORDER BY e.received_at, e.event_id LIMIT ?`).all(ms(e.before), ms(e.before), e.limit) as Row[])
          .map(r => ({ eventId: r.event_id as string, eventType: r.event_type as string, occurredAt: iso(r.occurred_at)! }));
      },
    },
    async recordEvent(e) {
      q(`INSERT INTO paddle_events (event_id, event_type, occurred_at, received_at, status)
         VALUES (?, ?, ?, ?, 'received') ON CONFLICT (event_id) DO NOTHING`).run(
        e.eventId, e.eventType, ms(e.occurredAt), ms(e.receivedAt),
      );
      const row = q(`SELECT status FROM paddle_events WHERE event_id = ?`).get(e.eventId) as { status: EventStatus };
      if (DONE.has(row.status)) return { alreadyDone: true };
      if (e.leaseExpiredBefore === undefined) return { alreadyDone: false };
      const claim = q(`INSERT INTO paddle_event_leases (event_id, claimed_at, claim_token) VALUES (?, ?, ?)
         ON CONFLICT (event_id) DO UPDATE SET claimed_at = excluded.claimed_at, claim_token = excluded.claim_token
         WHERE paddle_event_leases.claimed_at < ?`).run(e.eventId, ms(e.receivedAt), e.claimToken ?? null, ms(e.leaseExpiredBefore));
      return claim.changes > 0 ? { alreadyDone: false } : { alreadyDone: false, inProgress: true };
    },
    async markEvent(eventId, status, reason, claimToken) {
      if (claimToken === undefined) {
        q(`UPDATE paddle_events SET status = ?, reason = ? WHERE event_id = ?`).run(status, reason, eventId);
        q(`DELETE FROM paddle_event_leases WHERE event_id = ?`).run(eventId);
        return;
      }
      // Synchronous statements on one connection: nothing runs between the conditional release and the status write.
      if (q(`DELETE FROM paddle_event_leases WHERE event_id = ? AND claim_token = ?`).run(eventId, claimToken).changes === 0) return false;
      q(`UPDATE paddle_events SET status = ?, reason = ? WHERE event_id = ?`).run(status, reason, eventId);
      return true;
    },
    async recordFailure(reason, at) {
      const t = at.getTime();
      q(`INSERT INTO paddle_failures (bucket, reason, hits, last_at) VALUES (?, ?, 1, ?)
         ON CONFLICT (bucket, reason) DO UPDATE SET hits = hits + 1, last_at = MAX(last_at, excluded.last_at)`).run(
        Math.floor(t / 60_000) * 60_000, reason, t,
      );
    },
    async upsertCustomer(c: Customer) {
      const r = q(`INSERT INTO paddle_customers (customer_id, email, last_event_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (customer_id) DO UPDATE SET email = excluded.email, last_event_at = excluded.last_event_at,
           updated_at = excluded.updated_at
         WHERE paddle_customers.last_event_at <= excluded.last_event_at`).run(
        c.customerId, c.email, ms(c.lastEventAt), Date.now(),
      );
      return { applied: r.changes > 0 };
    },
    upsertSubscription: writeSubscription,
    applySubscription: s => writeSubscription({ ...s, pastDueSince: s.status === 'past_due' ? s.lastEventAt : null }, true),
    async recordTransaction(t) {
      q(`INSERT INTO paddle_transactions (transaction_id, owned, subscription_id, customer_id, occurred_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (transaction_id) DO UPDATE SET owned = MAX(paddle_transactions.owned, excluded.owned)`).run(
        t.transactionId, t.owned ? 1 : 0, t.subscriptionId, t.customerId, ms(t.occurredAt), ms(t.receivedAt),
      );
    },
    async getTransaction(id) {
      const r = q(`SELECT transaction_id, owned FROM paddle_transactions WHERE transaction_id = ?`).get(id) as Row | undefined;
      return r ? { transactionId: r.transaction_id as string, owned: Number(r.owned) === 1 } : null;
    },
    async getSubscription(id) {
      const r = q(`SELECT * FROM paddle_subscriptions WHERE subscription_id = ?`).get(id) as Row | undefined;
      return r ? toSubscription(r) : null;
    },
    async getSubscriptionsByUser(userId) {
      return (q(`SELECT * FROM paddle_subscriptions WHERE user_id = ? ORDER BY last_event_at DESC`).all(userId) as Row[]).map(
        toSubscription,
      );
    },
    async health(now): Promise<Health> {
      const until = now.getTime();
      const since = until - DAY_MS;
      const agg = q(`SELECT
           (SELECT MAX(received_at) FROM paddle_events WHERE status IN ('processed','ignored','stale')) AS last_event_at,
           (SELECT COUNT(*) FROM paddle_events WHERE status = 'failed' AND received_at > ? AND received_at <= ?) AS failed_events,
           (SELECT COALESCE(SUM(hits), 0) FROM paddle_failures WHERE last_at > ? AND last_at <= ?) AS failed_requests,
           (SELECT COUNT(*) FROM paddle_events WHERE reason = 'no_user_id' AND received_at > ? AND received_at <= ?) AS unlinked,
           (SELECT MAX(received_at) FROM paddle_events WHERE status = 'processed' AND (reason IS NULL OR reason = 'no_user_id')) AS last_owned_at,
           (SELECT COUNT(*) FROM paddle_events WHERE reason = 'not_ours' AND received_at > ? AND received_at <= ?) AS not_ours,
           (SELECT COUNT(*) FROM paddle_events WHERE status = 'failed') AS unresolved_failed,
           (SELECT MIN(received_at) FROM paddle_events WHERE status = 'received') AS oldest_pending`).get(
        since, until, since, until, since, until, since, until,
      ) as Row;
      const last = q(`SELECT at, reason FROM (
           SELECT received_at AS at, COALESCE(reason, 'store_error') AS reason FROM paddle_events WHERE status = 'failed'
           UNION ALL SELECT last_at AS at, reason FROM paddle_failures
         ) ORDER BY at DESC LIMIT 1`).get() as Row | undefined;
      return {
        lastEventAt: iso(agg.last_event_at),
        unresolvedFailed: Number(agg.unresolved_failed),
        oldestPendingAt: iso(agg.oldest_pending),
        lastFailureAt: iso(last?.at),
        lastFailureReason: (last?.reason as ReasonCode | undefined) ?? null,
        failedLast24h: Number(agg.failed_events) + Number(agg.failed_requests),
        unlinkedLast24h: Number(agg.unlinked),
        lastOwnedAt: iso(agg.last_owned_at),
        notOursLast24h: Number(agg.not_ours),
      };
    },
  };
}
