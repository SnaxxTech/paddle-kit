// Fulfilment of one-time payments, and an outbox for side effects (since v0.8.6). Postgres, migration 005.
// The kit keeps each payment's state and every adjustment, and decides when to grant, take back or give back; the app
// writes only what those mean for its users (credits, an unlock, …). Edge-safe: SQL through the app's own client.
import { adjustmentEffect, paymentRevoked } from '../core/adjustments';
import type { BillingConfig } from '../core/billing';
import type { CheckResult, Transaction } from '../core/types';
import { redactSecrets } from '../core/paddle-api';

/** One query on the app's Postgres client: pg, @neondatabase/serverless Pool, postgres-js wrapper, PGlite. */
export interface SqlTx {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}
/** A client that runs `fn` in one real transaction (BEGIN … COMMIT, ROLLBACK when it throws). */
export interface SqlDb {
  transaction<T>(fn: (q: SqlTx) => Promise<T>): Promise<T>;
}

export interface Fulfilment<G> {
  transactionId: string;
  userId: string;
  /** What the payment grants, as `orderOf` returned it (stored as JSON). */
  grants: G;
}

export interface FulfilmentActions<G> {
  /**
   * What a completed one-time payment grants, or `null` when it is not one the app fulfils by itself (no user, a price
   * of nothing it sells): then a review row keeps the paid order visible for a person. `customData.userId` is
   * untrusted (the most a user can do is pay for someone else); prefer a server-created checkout.
   */
  orderOf(tx: Transaction): { userId: string; grants: G } | null;
  /** Gives the payment's `grants` to the user. Runs once per payment (again only after a restore). */
  grant(q: SqlTx, f: Fulfilment<G>): Promise<void>;
  /**
   * Takes the payment back (a full refund or a chargeback that stands). Return what was actually taken (credits
   * already spent are gone): it is stored and handed to `restore`. Return `null` when there is nothing to measure.
   */
  revoke(q: SqlTx, f: Fulfilment<G>): Promise<unknown>;
  /** Gives back exactly what `revoke` took, when the refund or chargeback is reversed. */
  restore(q: SqlTx, f: Fulfilment<G> & { taken: unknown }): Promise<void>;
}

const RANK = `CASE $5 WHEN 'pending_approval' THEN 0 WHEN 'reversed' THEN 2 ELSE 1 END`;

async function review(q: SqlTx, id: string, transactionId: string, kind: string, detail: string) {
  await q.query(
    'INSERT INTO paddle_fulfilment_reviews (id, transaction_id, kind, detail) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
    [id, transactionId, kind, detail],
  );
}

/**
 * `onTransaction` and `onAdjustment` hooks for `createBilling` / `billingFromEnv`. Each payment's changes run one at
 * a time (a transaction-scoped advisory lock on its id) and inside the app's own database transaction, so a payment,
 * its refunds and chargebacks can arrive in any order, twice, or at the same moment and still end in one state:
 * - a refund or chargeback that arrived before its payment: the payment grants nothing until it is reversed;
 * - a reversal gives back what the revoke took, never more (spent credits stay spent);
 * - a partial refund or a chargeback warning becomes a review row (a person decides); so does a paid order `orderOf`
 *   does not fulfil. Subscription payments are left to entitlements.
 */
export function createFulfilment<G>(db: SqlDb, actions: FulfilmentActions<G>): Pick<BillingConfig, 'onTransaction' | 'onAdjustment'> {
  const lock = (q: SqlTx, transactionId: string) => q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [transactionId]);

  async function settle(q: SqlTx, transactionId: string) {
    const row = (await q.query('SELECT user_id, grants, state, taken FROM paddle_fulfilments WHERE transaction_id = $1', [transactionId])).rows[0];
    if (!row) return; // not paid yet: the payment settles when it arrives
    const adjustments = (await q.query('SELECT action, type, status FROM paddle_fulfilment_adjustments WHERE transaction_id = $1', [transactionId])).rows;
    const revoked = paymentRevoked(adjustments);
    const f: Fulfilment<G> = { transactionId, userId: row.user_id, grants: row.grants as G };
    const set = (state: string, taken: unknown) =>
      q.query('UPDATE paddle_fulfilments SET state = $1, taken = $2, updated_at = now() WHERE transaction_id = $3', [state, taken === null || taken === undefined ? null : JSON.stringify(taken), transactionId]);
    if (revoked && row.state === 'granted') {
      await set('revoked', await actions.revoke(q, f));
    } else if (!revoked && row.state === 'revoked') {
      await actions.restore(q, { ...f, taken: row.taken });
      await set('granted', null);
    } else if (!revoked && row.state === 'held') {
      await actions.grant(q, f);
      await set('granted', null);
    }
  }

  return {
    onTransaction: async (tx) => {
      if (tx.subscriptionId !== null) return; // a subscription payment: entitlements handle it
      const order = actions.orderOf(tx);
      await db.transaction(async (q) => {
        await lock(q, tx.transactionId);
        if (!order) {
          // Paid, but not fulfilled automatically: keep it (never only a log line), once per payment.
          await review(q, `txn:${tx.transactionId}`, tx.transactionId, 'unfulfilled_payment', `${tx.currency} ${tx.total}: ${tx.items.map((i) => i.priceId).join(', ')}`);
          return;
        }
        // 'held' until settle decides: a refund that arrived first keeps it from ever being granted.
        const ins = await q.query(
          `INSERT INTO paddle_fulfilments (transaction_id, user_id, grants, state) VALUES ($1, $2, $3, 'held')
           ON CONFLICT (transaction_id) DO NOTHING RETURNING transaction_id`,
          [tx.transactionId, order.userId, JSON.stringify(order.grants)],
        );
        if (ins.rows.length === 0) return; // a replay of a payment already recorded
        await settle(q, tx.transactionId);
      });
    },
    onAdjustment: async (adj) => {
      const effect = adjustmentEffect(adj);
      await db.transaction(async (q) => {
        await lock(q, adj.transactionId);
        // Kept whatever the effect, even before its payment arrives. A status only moves forward
        // (pending_approval → approved / rejected → reversed), so a late, older delivery changes nothing.
        await q.query(
          `INSERT INTO paddle_fulfilment_adjustments (adjustment_id, transaction_id, action, type, status, rank)
           VALUES ($1, $2, $3, $4, $5, ${RANK})
           ON CONFLICT (adjustment_id) DO UPDATE SET status = EXCLUDED.status, rank = EXCLUDED.rank
           WHERE paddle_fulfilment_adjustments.rank < EXCLUDED.rank`,
          [adj.adjustmentId, adj.transactionId, adj.action, adj.type, adj.status],
        );
        if (effect === 'review') await review(q, `adj:${adj.adjustmentId}:${adj.status}`, adj.transactionId, adj.action, `${adj.currency} ${adj.total}`);
        await settle(q, adj.transactionId);
      });
    },
  };
}

// ---------- outbox ----------

/**
 * Queues a side effect (an email, a job) in the caller's transaction, so it is sent only if the payment's changes
 * commit. `id` is the idempotency key (e.g. `${transactionId}:receipt`): a retried webhook adds nothing.
 */
export async function enqueue(q: SqlTx, item: { id: string; kind: string; payload: unknown }): Promise<void> {
  await q.query('INSERT INTO paddle_outbox (id, kind, payload) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [item.id, item.kind, JSON.stringify(item.payload ?? null)]);
}

export interface OutboxHandlers {
  [kind: string]: (payload: any, item: { id: string; attempts: number }) => Promise<void>;
}

export interface DrainOptions {
  /** Items per run. Default 20. */
  limit?: number;
  /** After this many failed attempts an item stops being retried (it stays visible in `outboxCheck`). Default 8. */
  maxAttempts?: number;
  /** How long a claimed item is hidden from other runs while it is being sent. Default 120 s. */
  leaseSeconds?: number;
}

/**
 * Sends due outbox items at least once: claims up to `limit` due items (other runs skip them for `leaseSeconds`),
 * calls the handler for each kind, marks it sent, or schedules a retry with exponential backoff (1 min, 2, 4, … 6 h).
 * A handler must be safe to call twice for one item (a crash after sending, before marking, sends it again). Run it
 * from the recovery cron (`createRecoveryRoute({ drainOutbox })`). Errors are stored redacted and cut to 200 characters.
 */
export async function drainOutbox(
  query: SqlTx['query'],
  handlers: OutboxHandlers,
  o: DrainOptions = {},
): Promise<{ sent: number; failed: number; gaveUp: number }> {
  const limit = o.limit ?? 20;
  const maxAttempts = o.maxAttempts ?? 8;
  const claimed = (await query(
    `UPDATE paddle_outbox SET next_at = now() + make_interval(secs => $3)
      WHERE id IN (SELECT id FROM paddle_outbox WHERE sent_at IS NULL AND next_at <= now() AND attempts < $2
                   ORDER BY next_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        -- Rechecked on a row another run claimed meanwhile (Postgres re-evaluates these on the newest row version).
        AND sent_at IS NULL AND next_at <= now()
      RETURNING id, kind, payload, attempts`,
    [limit, maxAttempts, o.leaseSeconds ?? 120],
  )).rows;
  let sent = 0;
  let failed = 0;
  let gaveUp = 0;
  for (const item of claimed) {
    const handler = handlers[item.kind];
    try {
      if (!handler) throw new Error(`no handler for kind "${item.kind}"`);
      await handler(item.payload, { id: item.id, attempts: item.attempts });
      await query('UPDATE paddle_outbox SET sent_at = now(), last_error = NULL WHERE id = $1', [item.id]);
      sent++;
    } catch (error) {
      const attempts = Number(item.attempts) + 1;
      const backoffSeconds = Math.min(60 * 2 ** (attempts - 1), 6 * 3600);
      const message = redactSecrets(`${(error as Error)?.name ?? 'Error'}: ${(error as Error)?.message ?? String(error)}`).slice(0, 200);
      await query(
        'UPDATE paddle_outbox SET attempts = $2, last_error = $3, next_at = now() + make_interval(secs => $4) WHERE id = $1',
        [item.id, attempts, message, backoffSeconds],
      );
      if (attempts >= maxAttempts) gaveUp++;
      else failed++;
    }
  }
  return { sent, failed, gaveUp };
}

/**
 * A health check (`createBilling({ healthChecks: { outbox: outboxCheck(query) } })`): red when an item gave up, or has
 * waited longer than `maxAgeMinutes` (default 60) unsent. The detail counts them and names the oldest item's kind.
 */
export function outboxCheck(query: SqlTx['query'], o: { maxAgeMinutes?: number; maxAttempts?: number } = {}): () => Promise<CheckResult> {
  return async () => {
    const r = (await query(
      `SELECT count(*) FILTER (WHERE attempts >= $2)::int AS gave_up,
              count(*) FILTER (WHERE created_at < now() - make_interval(mins => $1))::int AS late,
              (array_agg(kind ORDER BY created_at))[1] AS oldest_kind
         FROM paddle_outbox WHERE sent_at IS NULL`,
      [o.maxAgeMinutes ?? 60, o.maxAttempts ?? 8],
    )).rows[0];
    if (!r || (r.gave_up === 0 && r.late === 0)) return { ok: true };
    return { ok: false, detail: `${r.gave_up} gave up, ${r.late} waiting over ${o.maxAgeMinutes ?? 60} min (oldest: ${r.oldest_kind})` };
  };
}
