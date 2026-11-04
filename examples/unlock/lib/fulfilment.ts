// What the lifetime unlock means for this app. The kit calls these inside the payment's lock and transaction, once
// each: grant on payment, revoke on a refund or chargeback that stands, restore when it is reversed.
import { enqueue, type FulfilmentActions } from 'paddle-kit/fulfil';

export function unlockActions(productOf: (priceId: string) => string | null): FulfilmentActions<{ unlock: 'lifetime' }> {
  return {
    orderOf(tx) {
      const userId = tx.customData?.userId;
      const ok = tx.items.length > 0 && tx.items.every((i) => productOf(i.priceId) === 'lifetime');
      return typeof userId === 'string' && ok ? { userId, grants: { unlock: 'lifetime' } } : null; // null: a review row
    },
    async grant(q, f) {
      // Paid while an unlock is still valid: declined (a review row, refund it in Paddle). Locked per user, so two
      // payments at the same moment cannot both pass this check.
      await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`unlock:${f.userId}`]);
      if ((await q.query('SELECT 1 FROM unlock_grants WHERE user_id = $1 LIMIT 1', [f.userId])).rows.length > 0) return { declined: 'already_unlocked' };
      await q.query('INSERT INTO unlock_grants (transaction_id, user_id) VALUES ($1, $2) ON CONFLICT (transaction_id) DO NOTHING', [f.transactionId, f.userId]);
      await enqueue(q, { id: `${f.transactionId}:receipt`, kind: 'receipt', payload: { userId: f.userId } });
    },
    async revoke(q, f) {
      await q.query('DELETE FROM unlock_grants WHERE transaction_id = $1', [f.transactionId]);
      return null;
    },
    // A reversed refund makes this payment valid again, whatever other payments did meanwhile.
    async restore(q, f) {
      await q.query('INSERT INTO unlock_grants (transaction_id, user_id) VALUES ($1, $2) ON CONFLICT (transaction_id) DO NOTHING', [f.transactionId, f.userId]);
    },
  };
}
