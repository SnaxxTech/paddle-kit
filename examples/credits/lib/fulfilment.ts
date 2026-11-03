// What a credit pack means for this app: 100 credits per pack. The kit calls these inside the payment's lock and
// transaction, once each: grant on payment, revoke on a refund or chargeback that stands, restore on its reversal.
import { enqueue, type FulfilmentActions } from 'paddle-kit/fulfil';

export const CREDITS_PER_PACK = 100;

export function creditActions(productOf: (priceId: string) => string | null): FulfilmentActions<{ credits: number }> {
  return {
    orderOf(tx) {
      const userId = tx.customData?.userId;
      const ok = tx.items.length > 0 && tx.items.every((i) => productOf(i.priceId) === 'pack');
      const credits = CREDITS_PER_PACK * tx.items.reduce((n, i) => n + i.quantity, 0);
      return typeof userId === 'string' && ok ? { userId, grants: { credits } } : null; // null: a review row
    },
    async grant(q, f) {
      await q.query('INSERT INTO credit_accounts (user_id, credits) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET credits = credit_accounts.credits + $2', [f.userId, f.grants.credits]);
      await enqueue(q, { id: `${f.transactionId}:receipt`, kind: 'receipt', payload: { userId: f.userId } });
    },
    // Credits already spent are gone: take what is left, and return it so a reversal gives back exactly that.
    async revoke(q, f) {
      const balance = (await q.query('SELECT credits FROM credit_accounts WHERE user_id = $1 FOR UPDATE', [f.userId])).rows[0]?.credits ?? 0;
      const take = Math.min(balance, f.grants.credits);
      await q.query('UPDATE credit_accounts SET credits = credits - $1 WHERE user_id = $2', [take, f.userId]);
      return take;
    },
    async restore(q, f) {
      await q.query('UPDATE credit_accounts SET credits = credits + $1 WHERE user_id = $2', [Number(f.taken), f.userId]);
    },
  };
}
