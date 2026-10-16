import { nextPastDueSince } from '../core/access';
import type { Billing } from '../core/billing';
import { customDataOf, itemsOf, subscriptionFrom } from '../core/events';
import { ownershipPredicate } from '../core/owns';
import { LIVE_BASE, SANDBOX_BASE, paddleClient, type FetchLike } from '../core/paddle-api';

export type { FetchLike };

/**
 * Re-reads every subscription from the Paddle API and upserts it into the mirror, through the same mapping as the
 * webhook path. Each row carries the API's `updated_at`, so a webhook that occurred later still wins. Web fetch only.
 * `invalid` counts entities the webhook path would also reject (unknown status, missing ids).
 */
export async function reconcile(
  billing: Billing,
  opts: { apiKey: string; fetch?: FetchLike },
): Promise<{ scanned: number; applied: number; notOurs: number; invalid: number }> {
  const keyEnv = opts.apiKey.startsWith('pdl_sdbx_') ? 'sandbox' : opts.apiKey.startsWith('pdl_live_') ? 'production' : null;
  if (keyEnv !== billing.config.environment) {
    throw new Error(`paddle-kit: API key does not match environment "${billing.config.environment}"`);
  }
  const base = billing.config.environment === 'production' ? LIVE_BASE : SANDBOX_BASE;
  const api = paddleClient(base, opts.apiKey, opts.fetch ?? ((url, init) => fetch(url, init)), [opts.apiKey]);
  const owns = ownershipPredicate(billing.config.owns);

  let scanned = 0;
  let applied = 0;
  let notOurs = 0;
  let invalid = 0;
  for (const data of await api.list('/subscriptions?per_page=200', 1000)) {
    scanned++;
    const sub = subscriptionFrom(data, typeof data.updated_at === 'string' ? data.updated_at : '');
    if (!sub || Number.isNaN(Date.parse(sub.lastEventAt))) {
      invalid++;
      continue;
    }
    const prev = await billing.store.getSubscription(sub.subscriptionId);
    // A shared seller account lists every product's subscriptions: mirror only ours (or ones already mirrored).
    if (owns && !prev && !owns({ kind: 'subscription', items: itemsOf(sub), customData: customDataOf(sub) })) {
      notOurs++;
      continue;
    }
    const result = await billing.store.upsertSubscription({ ...sub, pastDueSince: nextPastDueSince(prev, sub.status, sub.lastEventAt) });
    if (result.applied) applied++;
  }
  return { scanned, applied, notOurs, invalid };
}
