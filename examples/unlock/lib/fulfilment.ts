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
      const ins = await q.query('INSERT INTO user_unlocks (user_id, transaction_id) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING RETURNING user_id', [f.userId, f.transactionId]);
      if (ins.rows.length === 0) return { declined: 'already_unlocked' }; // paid twice: a review row, refund it in Paddle
      await enqueue(q, { id: `${f.transactionId}:receipt`, kind: 'receipt', payload: { userId: f.userId } });
    },
    async revoke(q, f) {
      await q.query('DELETE FROM user_unlocks WHERE user_id = $1 AND transaction_id = $2', [f.userId, f.transactionId]);
      return null;
    },
    async restore(q, f) {
      await q.query('INSERT INTO user_unlocks (user_id, transaction_id) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING', [f.userId, f.transactionId]);
    },
  };
}
