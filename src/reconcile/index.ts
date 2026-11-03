import { nextPastDueSince } from '../core/access';
import { processorOf, type Billing } from '../core/billing';
import { customDataOf, itemsOf, parseEvent, subscriptionFrom } from '../core/events';
import type { ProcessResult } from '../core/handler';
import { resolveOwnership } from '../core/owns';
import { LIVE_BASE, PaddleError, SANDBOX_BASE, paddleClient, type FetchLike, type Json } from '../core/paddle-api';

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
  const api = apiFor(billing, opts);
  // A resolver that fails throws here: reconcile never mirrors every product's subscriptions because a lookup failed.
  const owns = await resolveOwnership(billing.config.owns);

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

function apiFor(billing: Billing, opts: { apiKey: string; fetch?: FetchLike }) {
  const keyEnv = opts.apiKey.startsWith('pdl_sdbx_') ? 'sandbox' : opts.apiKey.startsWith('pdl_live_') ? 'production' : null;
  if (keyEnv !== billing.config.environment) {
    throw new Error(`paddle-kit: API key does not match environment "${billing.config.environment}"`);
  }
  const base = billing.config.environment === 'production' ? LIVE_BASE : SANDBOX_BASE;
  return paddleClient(base, opts.apiKey, opts.fetch ?? ((url, init) => fetch(url, init)), [opts.apiKey]);
}

export interface PaymentCounts {
  /** Entities read from the API. */
  scanned: number;
  /** Replayed now: processed (hooks ran), or stale. */
  applied: number;
  /** Already replayed by an earlier run (the ledger row exists). */
  duplicates: number;
  /** Another product's (shared seller account). */
  notOurs: number;
  /** The replay failed (a hook threw, the store or the price lookup failed). Run again later. */
  failed: number;
}

/**
 * Repairs missed payment and refund webhooks: reads completed transactions updated since `since`, and adjustments
 * updated since then, from the Paddle API and replays each through the webhook's own ledger path, as a delivery with
 * its own event id (`reconcile_txn_<id>`, `reconcile_adj_<id>_<status>`). So `owns`, `onTransaction`,
 * `onAdjustment`, the claims and the dedup apply exactly as for a webhook, and a second run is a no-op.
 * A payment the webhook already processed runs its hook once more (at least once): hooks must be idempotent anyway.
 * Adjustments come after transactions, and an adjustment of a transaction the store never saw first replays that
 * transaction, so a refund is never judged without its payment. Web fetch only (edge-safe).
 */
export async function reconcilePayments(
  billing: Billing,
  opts: { apiKey: string; since: Date | string; fetch?: FetchLike },
): Promise<{ transactions: PaymentCounts; adjustments: PaymentCounts }> {
  const process = processorOf(billing);
  if (!process) throw new Error('paddle-kit: reconcilePayments needs a billing made by createBilling');
  const since = new Date(opts.since);
  if (Number.isNaN(since.getTime())) throw new Error('paddle-kit: reconcilePayments needs a valid `since`');
  const api = apiFor(billing, opts);
  const counts = (): PaymentCounts => ({ scanned: 0, applied: 0, duplicates: 0, notOurs: 0, failed: 0 });
  const tally = (c: PaymentCounts, r: ProcessResult | null) => {
    if (!r || r.outcome === 'failed' || r.outcome === 'in_progress') c.failed++;
    else if (r.outcome === 'duplicate') c.duplicates++;
    else if (r.reason === 'not_ours') c.notOurs++;
    else c.applied++;
  };
  const replay = (eventId: string, eventType: string, data: Json) => {
    const at = typeof data.updated_at === 'string' ? data.updated_at : typeof data.created_at === 'string' ? data.created_at : new Date().toISOString();
    const ev = parseEvent({ event_id: eventId, event_type: eventType, occurred_at: at, data });
    return ev ? process(ev) : Promise.resolve(null);
  };

  const transactions = counts();
  const sinceParam = encodeURIComponent(since.toISOString());
  for (const tx of await api.list(`/transactions?status=completed&updated_at%5BGTE%5D=${sinceParam}&order_by=updated_at%5BASC%5D&per_page=30`, 1000)) {
    transactions.scanned++;
    tally(transactions, await replay(`reconcile_txn_${tx.id}`, 'transaction.completed', tx));
  }

  const adjustments = counts();
  // GET /adjustments has no date filter: read the list (up to 200 pages of 50) and keep those updated since `since`.
  // ponytail: reads the whole list each run; filter by `transaction_id` in batches if an account passes 10,000 adjustments.
  const recent = (await api.list('/adjustments?per_page=50', 200))
    .filter((a) => Date.parse(a.updated_at ?? a.created_at) >= since.getTime())
    .sort((a, b) => Date.parse(a.updated_at ?? a.created_at) - Date.parse(b.updated_at ?? b.created_at));
  for (const adj of recent) {
    adjustments.scanned++;
    if (billing.store.getTransaction && typeof adj.transaction_id === 'string' && !(await billing.store.getTransaction(adj.transaction_id))) {
      try {
        const tx = (await api.call('GET', `/transactions/${encodeURIComponent(adj.transaction_id)}`)).data as Json;
        if (tx?.status === 'completed') tally(transactions, await replay(`reconcile_txn_${tx.id}`, 'transaction.completed', tx));
      } catch (error) {
        if (!(error instanceof PaddleError && error.status === 404)) throw error;
      }
    }
    tally(adjustments, await replay(`reconcile_adj_${adj.id}_${adj.status}`, 'adjustment.updated', adj));
  }
  return { transactions, adjustments };
}
