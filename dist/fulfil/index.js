import {
  adjustmentEffect,
  paymentRevoked
} from "../chunk-VS7IQNOM.js";
import {
  redactSecrets
} from "../chunk-KBHAKEOL.js";

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
  const taken = o.state === "revoked" && o.taken !== void 0 ? JSON.stringify(o.taken) : null;
  const ins = await q.query(
    `INSERT INTO paddle_fulfilments (transaction_id, user_id, grants, state, taken) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (transaction_id) DO NOTHING RETURNING transaction_id`,
    [o.transactionId, o.userId, JSON.stringify(o.grants), o.state, taken]
  );
  if (ins.rows.length === 0) return false;
  if (o.state === "revoked") {
    await q.query(
      `INSERT INTO paddle_fulfilment_adjustments (adjustment_id, transaction_id, action, type, status, rank)
       VALUES ($1, $2, $3, $4, 'approved', 1) ON CONFLICT (adjustment_id) DO NOTHING`,
      [`import:${o.transactionId}`, o.transactionId, o.revokedBy, o.revokedBy === "refund" ? "full" : null]
    );
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
  const claimed = (await query(
    `UPDATE paddle_outbox SET next_at = now() + make_interval(secs => $3)
      WHERE id IN (SELECT id FROM paddle_outbox WHERE sent_at IS NULL AND next_at <= now() AND attempts < $2
                   ORDER BY next_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        -- Rechecked on a row another run claimed meanwhile (Postgres re-evaluates these on the newest row version).
        AND sent_at IS NULL AND next_at <= now()
      RETURNING id, kind, payload, attempts`,
    [limit, maxAttempts, o.leaseSeconds ?? 120]
  )).rows;
  let sent = 0;
  let failed = 0;
  let gaveUp = 0;
  for (const item of claimed) {
    const handler = handlers[item.kind];
    try {
      if (!handler) throw new Error(`no handler for kind "${item.kind}"`);
      await handler(item.payload, { id: item.id, attempts: item.attempts });
      await query("UPDATE paddle_outbox SET sent_at = now(), last_error = NULL WHERE id = $1", [item.id]);
      sent++;
    } catch (error) {
      const attempts = Number(item.attempts) + 1;
      const backoffSeconds = Math.min(60 * 2 ** (attempts - 1), 6 * 3600);
      const message = redactSecrets(`${error?.name ?? "Error"}: ${error?.message ?? String(error)}`).slice(0, 200);
      await query(
        "UPDATE paddle_outbox SET attempts = $2, last_error = $3, next_at = now() + make_interval(secs => $4) WHERE id = $1",
        [item.id, attempts, message, backoffSeconds]
      );
      if (attempts >= maxAttempts) gaveUp++;
      else failed++;
    }
  }
  return { sent, failed, gaveUp };
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
