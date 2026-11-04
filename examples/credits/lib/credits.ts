import { db } from './db';

/** The user's balance. */
export async function creditsOf(userId: string): Promise<number> {
  return (await db.query('SELECT credits FROM credit_accounts WHERE user_id = $1', [userId])).rows[0]?.credits ?? 0;
}

/** Spends `n` credits if the user has them: one statement, so two requests cannot both spend the last ones. */
export async function spendCredits(userId: string, n: number): Promise<boolean> {
  if (!Number.isSafeInteger(n) || n <= 0) return false; // a negative amount would add credits; keep the cost server-side
  return (await db.query('UPDATE credit_accounts SET credits = credits - $2 WHERE user_id = $1 AND credits >= $2 RETURNING credits', [userId, n])).rows.length > 0;
}
