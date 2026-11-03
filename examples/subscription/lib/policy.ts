import { billing, enforce } from './billing';

/** The only place that decides whether `userId` may use `feature`. Reads the app's database: no Paddle call. */
export async function canUse(userId: string | null, feature: string): Promise<boolean> {
  if (!userId) return false;
  if (!billing) return !enforce; // billing not set up: free before launch, refused once BILLING_ENFORCE=1
  return billing.hasAccess(userId, feature);
}
