import { nextPastDueSince } from '../core/access';
import { processorOf, type Billing } from '../core/billing';
import { customDataOf, itemsOf, parseEvent, subscriptionFrom } from '../core/events';
import { within, type ProcessResult } from '../core/handler';
import { resolveOwnership } from '../core/owns';
import { LIVE_BASE, PaddleError, SANDBOX_BASE, paddleClient, type FetchLike, type Json } from '../core/paddle-api';
import type { RecoveryStore } from '../core/types';
import { PaddleTransportError } from '../core/transport';

export type { FetchLike };

/**
 * Re-reads every subscription from the Paddle API and upserts it into the mirror, through the same mapping as the
 * webhook path. Each row carries the API's `updated_at`, so a webhook that occurred later still wins. Web fetch only.
 * `invalid` counts entities the webhook path would also reject (unknown status, missing ids).
 */
export async function reconcile(
  billing: Billing,
  opts: { apiKey: string; fetch?: FetchLike; signal?: AbortSignal },
): Promise<{ scanned: number; applied: number; notOurs: number; invalid: number }> {
  const api = apiFor(billing, opts);
  // A resolver that fails throws here: reconcile never mirrors every product's subscriptions because a lookup failed.
  const owns = await resolveOwnership(billing.config.owns);

  let scanned = 0;
  let applied = 0;
  let notOurs = 0;
  let invalid = 0;
  for (const data of await api.list('/subscriptions?per_page=200', 1000)) {
    opts.signal?.throwIfAborted();
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
    const result = billing.store.applySubscription
      ? await billing.store.applySubscription(sub)
      : await billing.store.upsertSubscription({ ...sub, pastDueSince: nextPastDueSince(prev, sub.status, sub.lastEventAt) });
    if (result.applied) applied++;
  }
  return { scanned, applied, notOurs, invalid };
}

function apiFor(billing: Billing, opts: { apiKey: string; fetch?: FetchLike; signal?: AbortSignal }) {
  const keyEnv = opts.apiKey.startsWith('pdl_sdbx_') ? 'sandbox' : opts.apiKey.startsWith('pdl_live_') ? 'production' : null;
  if (keyEnv !== billing.config.environment) {
    throw new Error(`paddle-kit: API key does not match environment "${billing.config.environment}"`);
  }
  const base = billing.config.environment === 'production' ? LIVE_BASE : SANDBOX_BASE;
  return paddleClient(base, opts.apiKey, opts.fetch ?? billing.config.paddleFetch ?? ((url, init) => fetch(url, init)), [opts.apiKey], opts.signal);
}

/**
 * Keeps every price and product of `app` (the catalog CLI's product label), active AND archived, in the store's owned
 * ids, so a late payment or renewal on a price the app no longer sells is still recognised as its own. Adds only:
 * an id once owned stays owned. `recoverBilling` runs it first when `billing.config.catalogApp` is set.
 */
export async function syncOwnership(
  billing: Billing,
  opts: { apiKey: string; app: string; fetch?: FetchLike; signal?: AbortSignal },
): Promise<{ priceIds: number; productIds: number }> {
  const store = billing.store;
  if (!store.addOwnedIds) throw new Error('paddle-kit: syncOwnership needs a store with addOwnedIds (built-in stores: migration 004)');
  const api = apiFor(billing, opts);
  const prices = new Set<string>();
  const products = new Set<string>();
  for (const p of await api.list('/prices?status=active,archived&include=product&per_page=200', 50)) {
    opts.signal?.throwIfAborted();
    if (p.product?.custom_data?.paddle_kit !== opts.app || typeof p.id !== 'string' || typeof p.product.id !== 'string') continue;
    prices.add(p.id);
    products.add(p.product.id);
  }
  await store.addOwnedIds({ priceIds: [...prices].sort(), productIds: [...products].sort() }, new Date().toISOString());
  return { priceIds: prices.size, productIds: products.size };
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
  opts: { apiKey: string; since: Date | string; fetch?: FetchLike; signal?: AbortSignal },
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
    opts.signal?.throwIfAborted();
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
    opts.signal?.throwIfAborted();
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

export interface RecoveryOptions {
  apiKey: string;
  fetch?: FetchLike;
  /** A stable name scoped to this billing environment. Default environment. */
  name?: string;
  /** First successful run covers all history by default. Never silently rolls forward after an outage. */
  initialSince?: Date;
  overlapMs?: number;
  timeoutMs?: number;
  pendingLimit?: number;
  /** Must exceed the longest configured webhook claim lease. Default 5 minutes. */
  pendingAgeMs?: number;
  store?: RecoveryStore;
  now?: () => Date;
}

export type RecoveryResult =
  | { status: 'busy' }
  | { status: 'failed'; reason: 'incomplete' | 'timeout' | 'recovery_error' | 'api_error' | 'network' | 'circuit_open'; httpStatus?: number }
  | { status: 'done'; since: string; subscriptions: Awaited<ReturnType<typeof reconcile>>;
      payments: Awaited<ReturnType<typeof reconcilePayments>>; events: { applied: number; failed: number };
      /** Since v0.8.0, when `billing.config.catalogApp` is set: the owned ids `syncOwnership` found. */
      ownership?: { priceIds: number; productIds: number } };

/**
 * Durable self-repair: reclaim an expired job lease, replay unfinished original events, repair snapshots/payments,
 * and advance the checkpoint only after ALL work succeeds. Partial work is safe to retry through the same ledger.
 * Use one runner from an authenticated cron. This does not create a scheduler or retry irreversible app side effects.
 */
export async function recoverBilling(billing: Billing, opts: RecoveryOptions): Promise<RecoveryResult> {
  const store = opts.store ?? billing.store.recovery;
  if (!store) throw new Error('paddle-kit: recovery needs a RecoveryStore (built-in stores require migration 003)');
  const timeoutMs = opts.timeoutMs ?? 45000;
  const overlapMs = opts.overlapMs ?? 3600000;
  const pendingLimit = opts.pendingLimit ?? 100;
  const pendingAgeMs = opts.pendingAgeMs ?? 300000;
  const initial = opts.initialSince ?? new Date(0);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(overlapMs) || overlapMs < 0
      || !Number.isSafeInteger(pendingLimit) || pendingLimit < 1 || !Number.isSafeInteger(pendingAgeMs) || pendingAgeMs < 0
      || !Number.isFinite(initial.getTime())) throw new Error('paddle-kit: invalid recovery limits');
  const now = opts.now ?? (() => new Date());
  const startedAt = now();
  const name = opts.name ?? billing.config.environment;
  const runId = crypto.randomUUID();
  const controller = new AbortController();
  let claimed = false;
  let incomplete = false;
  let completed = false;
  const work = async (): Promise<RecoveryResult> => {
    claimed = await store.claimRecovery({ name, runId, startedAt: startedAt.toISOString(), leaseUntil: new Date(startedAt.getTime() + timeoutMs + 5000).toISOString() });
    controller.signal.throwIfAborted();
    if (!claimed) return { status: 'busy' };
    const state = await store.getRecovery(name);
    // Owned ids first: the replays below decide ownership from them.
    const app = billing.config.catalogApp;
    const ownership = app && billing.store.addOwnedIds
      ? await syncOwnership(billing, { apiKey: opts.apiKey, app, fetch: opts.fetch, signal: controller.signal })
      : null;
    controller.signal.throwIfAborted();
    // None found for the app (a wrong label, or an empty catalog): webhooks would keep answering 503. Not done.
    const noOwnedIds = ownership !== null && ownership.priceIds + ownership.productIds === 0
      && ((await billing.store.getOwnedIds?.())?.priceIds.length ?? 0) === 0;
    const since = new Date(Math.max(initial.getTime(), state?.checkpointAt ? Date.parse(state.checkpointAt) - overlapMs : initial.getTime()));
    const api = apiFor(billing, { ...opts, signal: controller.signal });
    const process = processorOf(billing);
    if (!process) throw new Error('paddle-kit: recovery needs a billing made by createBilling');
    const ids = await store.getPendingEvents({ before: new Date(startedAt.getTime() - pendingAgeMs).toISOString(), limit: pendingLimit + 1 });
    const events = { applied: 0, failed: Math.max(0, ids.length - pendingLimit) };
    for (const pending of ids.slice(0, pendingLimit)) {
      const id = pending.eventId;
      controller.signal.throwIfAborted();
      // Synthetic replays are repaired by reconcilePayments below; provider event IDs are fetched unchanged.
      if (!id.startsWith('evt_')) continue;
      try {
        // Paddle's filter searches entity data, not the envelope's event_id. Search a bounded time/type window,
        // then match the original ID exactly. Events outside Paddle's retention remain failures for a person.
        const occurred = Date.parse(pending.occurredAt);
        const params = new URLSearchParams({ from: new Date(occurred - 60000).toISOString(), to: new Date(occurred + 60000).toISOString(), event_type: pending.eventType, per_page: '200' });
        const envelope = (await api.list(`/events?${params}`, 5)).find(e => e.event_id === id);
        controller.signal.throwIfAborted();
        const event = parseEvent(envelope);
        if (!event || event.eventId !== id) { events.failed++; continue; }
        const result = await process(event);
        if (result.http !== 200) events.failed++;
        else events.applied++;
      } catch {
        controller.signal.throwIfAborted();
        events.failed++;
      }
    }
    const common = { apiKey: opts.apiKey, fetch: opts.fetch, signal: controller.signal };
    const subscriptions = await reconcile(billing, common);
    const payments = await reconcilePayments(billing, { ...common, since });
    controller.signal.throwIfAborted();
    const remaining = await store.getPendingEvents({ before: new Date(startedAt.getTime() - pendingAgeMs).toISOString(), limit: 1 });
    controller.signal.throwIfAborted();
    incomplete = noOwnedIds || subscriptions.invalid > 0 || events.failed > 0 || remaining.length > 0 || payments.transactions.failed > 0 || payments.adjustments.failed > 0;
    if (incomplete) throw new Error('incomplete recovery');
    completed = await store.finishRecovery({ name, runId, status: 'succeeded', finishedAt: now().toISOString(), reason: null });
    if (!completed) throw new Error('recovery lease lost');
    return { status: 'done', since: since.toISOString(), subscriptions, payments, events, ...(ownership ? { ownership } : {}) };
  };
  try {
    return await within(work(), timeoutMs, 'billing recovery');
  } catch (error) {
    controller.abort();
    const reason = incomplete ? 'incomplete' : (error as Error)?.name === 'TimeoutError' ? 'timeout'
      : error instanceof PaddleTransportError && ['network', 'timeout', 'circuit_open'].includes(error.code)
        ? error.code as 'network' | 'timeout' | 'circuit_open'
      : error instanceof PaddleError && error.status !== undefined ? 'api_error' : 'recovery_error';
    if (claimed && !completed) {
      try { await within(store.finishRecovery({ name, runId, status: 'failed', finishedAt: now().toISOString(), reason }), 2000, 'recovery status'); }
      catch { /* The database may be down; the durable lease expires and the next run takes over. */ }
    }
    return { status: 'failed', reason, ...(error instanceof PaddleError && error.status !== undefined ? { httpStatus: error.status } : {}) };
  }
}
