import {
  adjustmentEffect,
  paymentRevoked
} from "../chunk-VS7IQNOM.js";
import {
  redactSecrets
} from "../chunk-EHTDG5JE.js";

// src/fulfil/index.ts
var RANK = `CASE $5 WHEN 'pending_approval' THEN 0 WHEN 'reversed' THEN 2 ELSE 1 END`;
function revokedByOf(adjustments) {
  if (!paymentRevoked(adjustments)) return null;
  const approved = adjustments.filter((a) => a.status === "approved");
  return approved.some((a) => a.action === "refund" && a.type === "full") ? "refund" : "chargeback";
}
async function fulfilmentState(q, transactionId) {
  const row = (await q.query("SELECT user_id, grants, state, taken FROM paddle_fulfilments WHERE transaction_id = $1", [transactionId])).rows[0];
  if (!row) return null;
  const adjustments = (await q.query("SELECT action, type, status FROM paddle_fulfilment_adjustments WHERE transaction_id = $1 ORDER BY adjustment_id", [transactionId])).rows;
  return { state: row.state, userId: row.user_id, grants: row.grants, taken: row.taken ?? null, revokedBy: revokedByOf(adjustments), adjustments };
}
async function importFulfilment(q, o) {
  if (o.state === "revoked" && !o.adjustmentId) throw new Error("paddle-kit: importFulfilment of a revoked payment needs the adjustmentId that revoked it");
  const taken = o.state === "revoked" && o.taken !== void 0 ? JSON.stringify(o.taken) : null;
  const ins = await q.query(
    `INSERT INTO paddle_fulfilments (transaction_id, user_id, grants, state, taken) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (transaction_id) DO NOTHING RETURNING transaction_id`,
    [o.transactionId, o.userId, JSON.stringify(o.grants), o.state, taken]
  );
  if (ins.rows.length === 0) return false;
  if (o.state === "revoked") {
    const adj = await q.query(
      `INSERT INTO paddle_fulfilment_adjustments (adjustment_id, transaction_id, action, type, status, rank)
       VALUES ($1, $2, $3, $4, 'approved', 1)
       ON CONFLICT (adjustment_id) DO UPDATE SET adjustment_id = EXCLUDED.adjustment_id RETURNING transaction_id`,
      [o.adjustmentId, o.transactionId, o.revokedBy, o.revokedBy === "refund" ? "full" : null]
    );
    if (adj.rows[0]?.transaction_id !== o.transactionId) {
      throw new Error(`paddle-kit: importFulfilment: adjustment ${o.adjustmentId} belongs to another payment`);
    }
  }
  return true;
}
function createFulfilment(db, actions, options = {}) {
  const lock = (q, transactionId) => q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [transactionId]);
  async function review(q, r) {
    const ins = await q.query(
      "INSERT INTO paddle_fulfilment_reviews (id, transaction_id, kind, detail) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING RETURNING id",
      [r.id, r.transactionId, r.kind, r.detail]
    );
    if (ins.rows.length > 0 && options.onReview) await options.onReview(q, r);
  }
  async function settle(q, transactionId, cause) {
    const row = (await q.query("SELECT user_id, grants, state, taken FROM paddle_fulfilments WHERE transaction_id = $1", [transactionId])).rows[0];
    if (!row || row.state === "declined") return;
    const adjustments = (await q.query("SELECT action, type, status FROM paddle_fulfilment_adjustments WHERE transaction_id = $1", [transactionId])).rows;
    const revoked = paymentRevoked(adjustments);
    const f = { transactionId, userId: row.user_id, grants: row.grants };
    const set = (state, taken) => q.query("UPDATE paddle_fulfilments SET state = $1, taken = $2, updated_at = now() WHERE transaction_id = $3", [state, taken === null || taken === void 0 ? null : JSON.stringify(taken), transactionId]);
    if (revoked && row.state === "granted") {
      await set("revoked", await actions.revoke(q, { ...f, cause }));
    } else if (!revoked && row.state === "revoked") {
      await actions.restore(q, { ...f, taken: row.taken, cause });
      await set("granted", null);
    } else if (!revoked && row.state === "held") {
      const out = await actions.grant(q, f);
      if (out && typeof out === "object" && "declined" in out) {
        await set("declined", null);
        await review(q, { id: `declined:${transactionId}`, transactionId, kind: `declined:${out.declined}`, detail: JSON.stringify(row.grants) });
      } else {
        await set("granted", null);
      }
    } else if (revoked && row.state === "held" && !cause) {
      await review(q, { id: `held:${transactionId}`, transactionId, kind: "held_payment", detail: revokedByOf(adjustments) ?? "" });
    }
  }
  return {
    onTransaction: async (tx) => {
      if (tx.subscriptionId !== null) return;
      await db.transaction(async (q) => {
        await lock(q, tx.transactionId);
        const order = await actions.orderOf(tx, q);
        if (!order) {
          await review(q, { id: `txn:${tx.transactionId}`, transactionId: tx.transactionId, kind: "unfulfilled_payment", detail: `${tx.currency} ${tx.total}: ${tx.items.map((i) => i.priceId).join(", ")}` });
          return;
        }
        const ins = await q.query(
          `INSERT INTO paddle_fulfilments (transaction_id, user_id, grants, state) VALUES ($1, $2, $3, 'held')
           ON CONFLICT (transaction_id) DO NOTHING RETURNING transaction_id`,
          [tx.transactionId, order.userId, JSON.stringify(order.grants)]
        );
        if (ins.rows.length === 0) return;
        await settle(q, tx.transactionId, null);
      });
    },
    onAdjustment: async (adj) => {
      const effect = adjustmentEffect(adj);
      await db.transaction(async (q) => {
        await lock(q, adj.transactionId);
        await q.query(
          `INSERT INTO paddle_fulfilment_adjustments (adjustment_id, transaction_id, action, type, status, rank)
           VALUES ($1, $2, $3, $4, $5, ${RANK})
           ON CONFLICT (adjustment_id) DO UPDATE SET status = EXCLUDED.status, rank = EXCLUDED.rank
           WHERE paddle_fulfilment_adjustments.rank < EXCLUDED.rank`,
          [adj.adjustmentId, adj.transactionId, adj.action, adj.type, adj.status]
        );
        if (effect === "review") {
          await review(q, { id: `adj:${adj.adjustmentId}:${adj.status}`, transactionId: adj.transactionId, kind: adj.action, detail: `${adj.currency} ${adj.total}` });
        }
        await settle(q, adj.transactionId, { adjustmentId: adj.adjustmentId, action: adj.action, status: adj.status, type: adj.type });
      });
    }
  };
}
async function enqueue(q, item) {
  await q.query("INSERT INTO paddle_outbox (id, kind, payload) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING", [item.id, item.kind, JSON.stringify(item.payload ?? null)]);
}
async function drainOutbox(query, handlers, o = {}) {
  const limit = o.limit ?? 20;
  const maxAttempts = o.maxAttempts ?? 8;
  const out = { sent: 0, failed: 0, gaveUp: 0, lost: 0 };
  const token = `(extract(epoch FROM next_at) * 1000000)::bigint`;
  for (let n = 0; n < limit; n++) {
    const item = (await query(
      // A CTE runs once; `id IN (SELECT … LIMIT 1)` may be re-evaluated and claim more than one row.
      `WITH c AS (SELECT id FROM paddle_outbox WHERE sent_at IS NULL AND next_at <= clock_timestamp() AND attempts < $1
                  ORDER BY next_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
       UPDATE paddle_outbox o SET next_at = clock_timestamp() + make_interval(secs => $2), attempts = o.attempts + 1 FROM c
        WHERE o.id = c.id
          -- Rechecked on a row another run claimed meanwhile (Postgres re-evaluates these on the newest row version).
          AND o.sent_at IS NULL AND o.next_at <= clock_timestamp() AND o.attempts < $1
        RETURNING o.id, o.kind, o.payload, o.attempts, ${token.replace("next_at", "o.next_at")}::text AS token`,
      [maxAttempts, o.leaseSeconds ?? 120]
    )).rows[0];
    if (!item) break;
    const attempts = Number(item.attempts);
    const handler = handlers[item.kind];
    try {
      if (!handler) throw new Error(`no handler for kind "${item.kind}"`);
      await handler(item.payload, { id: item.id, attempts: attempts - 1 });
      await query("UPDATE paddle_outbox SET sent_at = clock_timestamp(), last_error = NULL WHERE id = $1 AND sent_at IS NULL", [item.id]);
      out.sent++;
    } catch (error) {
      const backoffSeconds = Math.min(60 * 2 ** (attempts - 1), 6 * 3600);
      const message = redactSecrets(`${error?.name ?? "Error"}: ${error?.message ?? String(error)}`).slice(0, 200);
      const done = await query(
        `UPDATE paddle_outbox SET last_error = $3, next_at = clock_timestamp() + make_interval(secs => $4)
          WHERE id = $1 AND ${token} = $2::bigint AND sent_at IS NULL RETURNING id`,
        [item.id, item.token, message, backoffSeconds]
      );
      if (done.rows.length === 0) out.lost++;
      else if (attempts >= maxAttempts) out.gaveUp++;
      else out.failed++;
    }
  }
  return out;
}
function outboxCheck(query, o = {}) {
  return async () => {
    const r = (await query(
      `SELECT count(*) FILTER (WHERE attempts >= $2)::int AS gave_up,
              count(*) FILTER (WHERE created_at < now() - make_interval(mins => $1))::int AS late,
              (array_agg(kind ORDER BY created_at))[1] AS oldest_kind
         FROM paddle_outbox WHERE sent_at IS NULL`,
      [o.maxAgeMinutes ?? 60, o.maxAttempts ?? 8]
    )).rows[0];
    if (!r || r.gave_up === 0 && r.late === 0) return { ok: true };
    return { ok: false, detail: `${r.gave_up} gave up, ${r.late} waiting over ${o.maxAgeMinutes ?? 60} min (oldest: ${r.oldest_kind})` };
  };
}
export {
  createFulfilment,
  drainOutbox,
  enqueue,
  fulfilmentState,
  importFulfilment,
  outboxCheck
};
