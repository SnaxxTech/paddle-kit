import { db } from './db';
import { billing, enforce } from './billing';

/** Whether `userId` bought the lifetime unlock (and it was not refunded or charged back). */
export async function canUse(userId: string | null): Promise<boolean> {
  if (!userId) return false;
  if (!billing) return !enforce;
  return (await db.query('SELECT 1 FROM user_unlocks WHERE user_id = $1', [userId])).rows.length > 0;
}
