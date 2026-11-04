// Fulfilment of one-time payments, and an outbox for side effects (since v0.8.6). Postgres, migration 005.
// The kit keeps each payment's state and every adjustment, and decides when to grant, take back or give back; the app
// writes only what those mean for its users (credits, an unlock, …). Edge-safe: SQL through the app's own client.
import { adjustmentEffect, paymentRevoked } from '../core/adjustments';
import type { BillingConfig } from '../core/billing';
import type { CheckResult, Transaction } from '../core/types';
import { jsonValue } from '../core/json';
import { redactSecrets } from '../core/paddle-api';
import { safeEqual } from '../core/signature';

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

/** The adjustment that made the kit call `revoke` or `restore` (since v0.8.6). */
export interface FulfilmentCause {
  adjustmentId: string;
  action: string;
  status: string;
  type: string | null;
}

export interface FulfilmentActions<G> {
  /**
   * What a completed one-time payment grants, or `null` when it is not one the app fulfils by itself (no user, a price
   * of nothing it sells): then a review row keeps the paid order visible for a person. Runs inside the payment's lock
   * and the app's transaction (`q`), so it may read the database; it may be async. `customData.userId` is untrusted
   * (the most a user can do is pay for someone else); prefer a server-created checkout.
   */
  orderOf(tx: Transaction, q: SqlTx): { userId: string; grants: G } | null | Promise<{ userId: string; grants: G } | null>;
  /**
   * Gives the payment's `grants` to the user. Runs once per payment (again only after a restore). Return
   * `{ declined: reason }` to refuse after checking under the lock (say, the order was already paid by another
   * transaction): the payment is then `declined`, a `declined:<reason>` review is written, and its later refunds and
   * chargebacks change nothing.
   */
  grant(q: SqlTx, f: Fulfilment<G>): Promise<void | { declined: string }>;
  /**
   * Takes the payment back (a full refund or a chargeback that stands). Return what was actually taken (credits
   * already spent are gone): it is stored and handed to `restore`. Return `null` when there is nothing to measure.
   * `cause` is the adjustment that made it stand.
   */
  revoke(q: SqlTx, f: Fulfilment<G> & { cause: FulfilmentCause }): Promise<unknown>;
  /** Gives back exactly what `revoke` took, when the refund or chargeback is reversed (`cause`). */
  restore(q: SqlTx, f: Fulfilment<G> & { taken: unknown; cause: FulfilmentCause }): Promise<void>;
}

/** A row of `paddle_fulfilment_reviews`, as `onReview` receives it. */
export interface FulfilmentReview {
  id: string;
  transactionId: string;
  kind: string;
  detail: string;
}

export interface FulfilmentOptions {
  /**
   * Called once for each new review row, in the same transaction (since v0.8.6): route it to the app's own alerting.
   * Kinds: `unfulfilled_payment`, `declined:<reason>`, `held_payment`, and the adjustment action of a partial refund
   * or a chargeback warning (`refund`, `chargeback_warning`, …).
   */
  onReview?(q: SqlTx, review: FulfilmentReview): Promise<void>;
}

export type FulfilmentStateName = 'held' | 'granted' | 'revoked' | 'declined';

const RANK = `CASE $5 WHEN 'pending_approval' THEN 0 WHEN 'reversed' THEN 2 ELSE 1 END`;

type AdjustmentRow = { action: string; type: string | null; status: string };

/** What takes a payment back now: an approved full refund first, else chargebacks not reversed. */
function revokedByOf(adjustments: readonly AdjustmentRow[]): 'refund' | 'chargeback' | null {
  if (!paymentRevoked(adjustments as never)) return null;
  const approved = adjustments.filter((a) => a.status === 'approved');
  return approved.some((a) => a.action === 'refund' && a.type === 'full') ? 'refund' : 'chargeback';
}

/**
 * Reads a payment's fulfilment (since v0.8.6): `null` when the kit has no row for it. `revokedBy` says what takes it
 * back now (also for a `held` payment whose refund or chargeback came first). For a checkout confirmation ("refunded",
 * "charged back") or a reconcile report; run it in a transaction to read a settled state.
 */
export async function fulfilmentState(q: SqlTx, transactionId: string): Promise<{
  state: FulfilmentStateName; userId: string; grants: unknown; taken: unknown; revokedBy: 'refund' | 'chargeback' | null;
  adjustments: AdjustmentRow[];
} | null> {
  const row = (await q.query('SELECT user_id, grants, state, taken FROM paddle_fulfilments WHERE transaction_id = $1', [transactionId])).rows[0];
  if (!row) return null;
  const adjustments = (await q.query('SELECT action, type, status FROM paddle_fulfilment_adjustments WHERE transaction_id = $1 ORDER BY adjustment_id', [transactionId])).rows as AdjustmentRow[];
  return { state: row.state, userId: row.user_id, grants: jsonValue(row.grants), taken: jsonValue(row.taken) ?? null, revokedBy: revokedByOf(adjustments), adjustments };
}

/**
 * Brings a payment fulfilled before the app used the kit into its tables (since v0.8.6), so a later refund is honoured
 * and a refunded order is not given back by an unrelated event. `state: 'revoked'` needs `revokedBy` and the Paddle
 * `adjustmentId` that took it back (since v0.8.7; `GET /adjustments?transaction_id=…`): it is recorded as that
 * approved refund or chargeback, so only its own reversal gives the order back, and a replay of it counts once.
 * Import only an adjustment Paddle shows as `approved`, and pass `taken` (what `restore` gives back on a reversal).
 * Run it in a transaction (two writes). Returns false when the kit already has the payment (nothing changes). Run it in a migration or a one-off script.
 */
export async function importFulfilment(
  q: SqlTx,
  o: { transactionId: string; userId: string; grants: unknown; state: 'granted' } | { transactionId: string; userId: string; grants: unknown; state: 'revoked'; revokedBy: 'refund' | 'chargeback'; adjustmentId: string; taken?: unknown },
): Promise<boolean> {
  if (o.state === 'revoked' && !o.adjustmentId) throw new Error('paddle-kit: importFulfilment of a revoked payment needs the adjustmentId that revoked it');
  const taken = o.state === 'revoked' && o.taken !== undefined ? JSON.stringify(o.taken) : null;
  const ins = await q.query(
    `INSERT INTO paddle_fulfilments (transaction_id, user_id, grants, state, taken) VALUES ($1, $2, $3::text::jsonb, $4, $5::text::jsonb)
     ON CONFLICT (transaction_id) DO NOTHING RETURNING transaction_id`,
    [o.transactionId, o.userId, JSON.stringify(o.grants), o.state, taken],
  );
  if (ins.rows.length === 0) return false;
  if (o.state === 'revoked') {
    const adj = await q.query(
      `INSERT INTO paddle_fulfilment_adjustments (adjustment_id, transaction_id, action, type, status, rank)
       VALUES ($1, $2, $3, $4, 'approved', 1)
       ON CONFLICT (adjustment_id) DO UPDATE SET adjustment_id = EXCLUDED.adjustment_id RETURNING transaction_id`,
      [o.adjustmentId, o.transactionId, o.revokedBy, o.revokedBy === 'refund' ? 'full' : null],
    );
    if (adj.rows[0]?.transaction_id !== o.transactionId) {
      throw new Error(`paddle-kit: importFulfilment: adjustment ${o.adjustmentId} belongs to another payment`);
    }
  }
  return true;
}

/**
 * `onTransaction` and `onAdjustment` hooks for `createBilling` / `billingFromEnv`. Each payment's changes run one at
 * a time (a transaction-scoped advisory lock on its id) and inside the app's own database transaction, so a payment,
 * its refunds and chargebacks can arrive in any order, twice, or at the same moment and still end in one state:
 * - a refund or chargeback that arrived before its payment: the payment grants nothing until it is reversed (a
 *   `held_payment` review says so);
 * - a reversal gives back what the revoke took, never more (spent credits stay spent);
 * - a partial refund or a chargeback warning becomes a review row (a person decides); so does a paid order `orderOf`
 *   does not fulfil, and one `grant` declines. Subscription payments are left to entitlements.
 */
export function createFulfilment<G>(db: SqlDb, actions: FulfilmentActions<G>, options: FulfilmentOptions = {}): Pick<BillingConfig, 'onTransaction' | 'onAdjustment'> {
  const lock = (q: SqlTx, transactionId: string) => q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [transactionId]);

  async function review(q: SqlTx, r: FulfilmentReview) {
    const ins = await q.query(
      'INSERT INTO paddle_fulfilment_reviews (id, transaction_id, kind, detail) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING RETURNING id',
      [r.id, r.transactionId, r.kind, r.detail],
    );
    if (ins.rows.length > 0 && options.onReview) await options.onReview(q, r);
  }

  async function settle(q: SqlTx, transactionId: string, cause: FulfilmentCause | null) {
    const row = (await q.query('SELECT user_id, grants, state, taken FROM paddle_fulfilments WHERE transaction_id = $1', [transactionId])).rows[0];
    if (!row || row.state === 'declined') return; // not paid yet (the payment settles when it arrives), or refused
    const adjustments = (await q.query('SELECT action, type, status FROM paddle_fulfilment_adjustments WHERE transaction_id = $1', [transactionId])).rows;
    const revoked = paymentRevoked(adjustments);
    const f: Fulfilment<G> = { transactionId, userId: row.user_id, grants: jsonValue<G>(row.grants) };
    const set = (state: FulfilmentStateName, taken: unknown) =>
      q.query('UPDATE paddle_fulfilments SET state = $1, taken = $2::text::jsonb, updated_at = now() WHERE transaction_id = $3', [state, taken === null || taken === undefined ? null : JSON.stringify(taken), transactionId]);
    // A revoke or restore only ever follows an adjustment, so `cause` is set on those paths.
    if (revoked && row.state === 'granted') {
      await set('revoked', await actions.revoke(q, { ...f, cause: cause! }));
    } else if (!revoked && row.state === 'revoked') {
      await actions.restore(q, { ...f, taken: jsonValue(row.taken), cause: cause! });
      await set('granted', null);
    } else if (!revoked && row.state === 'held') {
      const out = await actions.grant(q, f);
      if (out && typeof out === 'object' && 'declined' in out) {
        await set('declined', null);
        await review(q, { id: `declined:${transactionId}`, transactionId, kind: `declined:${out.declined}`, detail: JSON.stringify(jsonValue(row.grants)) });
      } else {
        await set('granted', null);
      }
    } else if (revoked && row.state === 'held' && !cause) {
      // The payment arrived after a refund or chargeback that still stands: kept, not granted.
      await review(q, { id: `held:${transactionId}`, transactionId, kind: 'held_payment', detail: revokedByOf(adjustments) ?? '' });
    }
  }

  return {
    onTransaction: async (tx) => {
      if (tx.subscriptionId !== null) return; // a subscription payment: entitlements handle it
      await db.transaction(async (q) => {
        await lock(q, tx.transactionId);
        const order = await actions.orderOf(tx, q);
        if (!order) {
          // Paid, but not fulfilled automatically: keep it (never only a log line), once per payment.
          await review(q, { id: `txn:${tx.transactionId}`, transactionId: tx.transactionId, kind: 'unfulfilled_payment', detail: `${tx.currency} ${tx.total}: ${tx.items.map((i) => i.priceId).join(', ')}` });
          return;
        }
        // 'held' until settle decides: a refund that arrived first keeps it from ever being granted.
        const ins = await q.query(
          `INSERT INTO paddle_fulfilments (transaction_id, user_id, grants, state) VALUES ($1, $2, $3::text::jsonb, 'held')
           ON CONFLICT (transaction_id) DO NOTHING RETURNING transaction_id`,
          [tx.transactionId, order.userId, JSON.stringify(order.grants)],
        );
        if (ins.rows.length === 0) return; // a replay of a payment already recorded
        await settle(q, tx.transactionId, null);
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
        if (effect === 'review') {
          await review(q, { id: `adj:${adj.adjustmentId}:${adj.status}`, transactionId: adj.transactionId, kind: adj.action, detail: `${adj.currency} ${adj.total}` });
        }
        await settle(q, adj.transactionId, { adjustmentId: adj.adjustmentId, action: adj.action, status: adj.status, type: adj.type });
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
  await q.query('INSERT INTO paddle_outbox (id, kind, payload) VALUES ($1, $2, $3::text::jsonb) ON CONFLICT (id) DO NOTHING', [item.id, item.kind, JSON.stringify(item.payload ?? null)]);
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
  /** No item is claimed after this many ms since the run started (since v0.9.0; default 20 s): bounded per run. */
  budgetMs?: number;
}

/**
 * Sends due outbox items at least once: claims one due item at a time (other runs skip it for `leaseSeconds`), calls
 * the handler for its kind, marks it sent, or schedules a retry with exponential backoff (1 min, 2, 4, … 6 h).
 * Since v0.8.7: each claim counts as an attempt; a failure changes the row only while that claim still holds it, so a
 * worker that ran past its lease cannot overwrite the retry state of the run that took the item over (`lost` counts
 * those); a send that finished is always marked sent.
 * A handler that runs past `leaseSeconds` can be called again by another run, and a crash after sending sends it again:
 * handlers must be idempotent on `item.id` (pass it as the idempotency key of the email or API call). Call it right
 * after the payment commits, and hourly as the backstop (`createOutboxRoute`, or `createRecoveryRoute({ drainOutbox })`).
 * Errors are stored redacted and cut to 200 characters.
 */
export async function drainOutbox(
  query: SqlTx['query'],
  handlers: OutboxHandlers,
  o: DrainOptions = {},
): Promise<{ sent: number; failed: number; gaveUp: number; lost: number }> {
  const limit = o.limit ?? 20;
  const maxAttempts = o.maxAttempts ?? 8;
  const out = { sent: 0, failed: 0, gaveUp: 0, lost: 0 };
  // clock_timestamp(), never now(): a caller's transaction freezes now() at its start.
  // The token is the claim's next_at in epoch microseconds: exact, and independent of the session's DateStyle.
  const token = `(extract(epoch FROM next_at) * 1000000)::bigint`;
  const started = Date.now();
  const budgetMs = o.budgetMs ?? 20_000;
  for (let n = 0; n < limit && Date.now() - started < budgetMs; n++) {
    // One at a time, so an item's lease starts when it is sent, not when the batch began. A claim counts as an
    // attempt, so an item whose handler always outlives its lease still stops at maxAttempts.
    const item = (await query(
      // A CTE runs once; `id IN (SELECT … LIMIT 1)` may be re-evaluated and claim more than one row.
      `WITH c AS (SELECT id FROM paddle_outbox WHERE sent_at IS NULL AND next_at <= clock_timestamp() AND attempts < $1
                  ORDER BY next_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
       UPDATE paddle_outbox o SET next_at = clock_timestamp() + make_interval(secs => $2), attempts = o.attempts + 1 FROM c
        WHERE o.id = c.id
          -- Rechecked on a row another run claimed meanwhile (Postgres re-evaluates these on the newest row version).
          AND o.sent_at IS NULL AND o.next_at <= clock_timestamp() AND o.attempts < $1
        RETURNING o.id, o.kind, o.payload, o.attempts, ${token.replace('next_at', 'o.next_at')}::text AS token`,
      [maxAttempts, o.leaseSeconds ?? 120],
    )).rows[0];
    if (!item) break;
    const attempts = Number(item.attempts);
    const handler = handlers[item.kind];
    try {
      if (!handler) throw new Error(`no handler for kind "${item.kind}"`);
      await handler(jsonValue(item.payload), { id: item.id, attempts: attempts - 1 });
      // Sent is final and true whoever holds the lease now: marked even after a takeover, so it is not sent again.
      await query('UPDATE paddle_outbox SET sent_at = clock_timestamp(), last_error = NULL WHERE id = $1 AND sent_at IS NULL', [item.id]);
      out.sent++;
    } catch (error) {
      const backoffSeconds = Math.min(60 * 2 ** (attempts - 1), 6 * 3600);
      const message = redactSecrets(`${(error as Error)?.name ?? 'Error'}: ${(error as Error)?.message ?? String(error)}`).slice(0, 200);
      // Only while this claim still holds the item: a run that took it over owns its retry state.
      const done = await query(
        `UPDATE paddle_outbox SET last_error = $3, next_at = clock_timestamp() + make_interval(secs => $4)
          WHERE id = $1 AND ${token} = $2::bigint AND sent_at IS NULL RETURNING id`,
        [item.id, item.token, message, backoffSeconds],
      );
      if (done.rows.length === 0) out.lost++;
      else if (attempts >= maxAttempts) out.gaveUp++;
      else out.failed++;
    }
  }
  return out;
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

/**
 * A health check (since v0.9.0): red while a fulfilment review is unresolved (a paid order nobody fulfilled, a
 * declined grant, a partial refund or a chargeback warning: each needs a person). `resolveReview` clears one.
 */
export function reviewsCheck(query: SqlTx['query']): () => Promise<CheckResult> {
  return async () => {
    const rows = (await query(
      'SELECT kind, count(*)::int AS n FROM paddle_fulfilment_reviews WHERE resolved_at IS NULL GROUP BY kind ORDER BY kind',
    )).rows as Array<{ kind: string; n: number }>;
    const total = rows.reduce((sum, r) => sum + Number(r.n), 0);
    if (total === 0) return { ok: true };
    return { ok: false, detail: `${total} unresolved fulfilment review${total === 1 ? '' : 's'} (${rows.map((r) => r.kind).join(', ')})` };
  };
}

/** Marks a review handled (since v0.9.0). False when it does not exist or was already resolved. */
export async function resolveReview(q: SqlTx, id: string): Promise<boolean> {
  return (await q.query('UPDATE paddle_fulfilment_reviews SET resolved_at = now() WHERE id = $1 AND resolved_at IS NULL RETURNING id', [id])).rows.length > 0;
}

/**
 * The outbox's own worker route (since v0.9.0): the hourly backstop for sends that failed right after the payment.
 * On a free-tier database keep it hourly (README "Free-tier databases"): `export const { GET } = createOutboxRoute({ cronSecret, drain: () => drainOutbox(…) })`.
 * Refuses (401) without `Authorization: Bearer <cronSecret>`, and always when `cronSecret` is unset. Answers the
 * drain's result, or 500 with the error's name only (a driver message may hold a secret). Bound it with the
 * drain's `limit` and `budgetMs`, below the route's own time limit.
 */
export function createOutboxRoute(opts: { cronSecret: string | undefined; drain: () => Promise<{ sent: number; failed: number; gaveUp: number; lost: number }> }) {
  return {
    GET: async (req: Request): Promise<Response> => {
      const secret = opts.cronSecret;
      if (!secret || !(await safeEqual(req.headers.get('authorization') ?? '', `Bearer ${secret}`))) return new Response(null, { status: 401 });
      try {
        return Response.json(await opts.drain());
      } catch (error) {
        return Response.json({ error: (error as Error)?.name ?? 'Error' }, { status: 500 });
      }
    },
  };
}
