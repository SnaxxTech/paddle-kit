import { nextPastDueSince } from '../core/access';
import { processorOf, type Billing } from '../core/billing';
import { customDataOf, itemsOf, parseEvent, subscriptionFrom } from '../core/events';
import { within, type ProcessResult } from '../core/handler';
import { resolveOwnership } from '../core/owns';
import { LIVE_BASE, PaddleError, SANDBOX_BASE, paddleClient, type FetchLike, type Json } from '../core/paddle-api';
import type { RecoveryProgress, RecoveryStore } from '../core/types';
import { PaddleTransportError } from '../core/transport';
import { safeEqual } from '../core/signature';

export type { FetchLike };

/**
 * Resume support for `recoverBilling` (since v0.8.7): start at `cursor` (a saved next-page path) and `save` the next
 * page's path after each page. After a page with a failed or invalid item, `fail` is called and nothing more is saved,
 * so the next run starts again at that page and retries it (replays of the items that worked are duplicates).
 */
export interface Pager {
  cursor: string | null;
  save(next: string | null): Promise<void>;
  fail(): void;
}

async function eachPage(api: ReturnType<typeof apiFor>, first: string, pager: Pager | undefined, maxPages: number,
  fn: (items: Json[]) => Promise<boolean>): Promise<void> {
  // A saved cursor is used only on the same endpoint (a window read another way starts the phase again).
  const endpoint = first.slice(0, first.indexOf('?') + 1);
  let next: string | null = pager?.cursor?.startsWith(endpoint) ? pager.cursor : first;
  for (let n = 0; next; n++) {
    if (n >= maxPages) throw new PaddleError('pagination limit reached: result is incomplete');
    const page = await api.page(next);
    if (await fn(page.data)) pager?.fail();
    next = page.next;
    await pager?.save(next);
  }
}

/**
 * Re-reads every subscription from the Paddle API and upserts it into the mirror, through the same mapping as the
 * webhook path. Each row carries the API's `updated_at`, so a webhook that occurred later still wins. Web fetch only.
 * `invalid` counts entities the webhook path would also reject (unknown status, missing ids).
 * With `since` within 89 days (since v0.8.7), only subscriptions with a `subscription.*` event since then are read,
 * from the event stream (each one's newest state), instead of every subscription; `recoverBilling` passes its window.
 */
export async function reconcile(
  billing: Billing,
  opts: { apiKey: string; fetch?: FetchLike; signal?: AbortSignal; since?: Date | string; until?: Date | string; pager?: Pager },
): Promise<{ scanned: number; applied: number; notOurs: number; invalid: number }> {
  const api = apiFor(billing, opts);
  // A resolver that fails throws here: reconcile never mirrors every product's subscriptions because a lookup failed.
  const owns = await resolveOwnership(billing.config.owns);

  let scanned = 0;
  let applied = 0;
  let notOurs = 0;
  let invalid = 0;
  const since = opts.since === undefined ? null : new Date(opts.since);
  if (since && Number.isNaN(since.getTime())) throw new Error('paddle-kit: reconcile needs a valid `since`');
  const until = opts.until === undefined ? null : new Date(opts.until);
  const apply = async (data: Json) => {
    opts.signal?.throwIfAborted();
    scanned++;
    const sub = subscriptionFrom(data, typeof data.updated_at === 'string' ? data.updated_at : '');
    if (!sub || Number.isNaN(Date.parse(sub.lastEventAt))) {
      invalid++;
      return;
    }
    const prev = await billing.store.getSubscription(sub.subscriptionId);
    // A shared seller account lists every product's subscriptions: mirror only ours (or ones already mirrored).
    if (owns && !prev && !owns({ kind: 'subscription', items: itemsOf(sub), customData: customDataOf(sub) })) {
      notOurs++;
      return;
    }
    const result = billing.store.applySubscription
      ? await billing.store.applySubscription(sub)
      : await billing.store.upsertSubscription({ ...sub, pastDueSince: nextPastDueSince(prev, sub.status, sub.lastEventAt) });
    if (result.applied) applied++;
  };
  let failedBefore = 0;
  const pageFailed = () => { const now = invalid; const bad = now > failedBefore; failedBefore = now; return bad; };
  if (since && Date.now() - since.getTime() <= EVENT_STREAM_WINDOW_MS) {
    const to = until ? `&to=${encodeURIComponent(until.toISOString())}` : '';
    const path = `/events?event_type=${SUBSCRIPTION_EVENTS}&from=${encodeURIComponent(since.toISOString())}${to}&order_by=id%5BASC%5D&per_page=200`;
    await eachPage(api, path, opts.pager, 200, async (items) => {
      const latest = new Map<string, Json>();
      for (const e of items) {
        const data = e?.data as Json | undefined;
        if (data && typeof data.id === 'string') latest.set(data.id, data); // oldest first: the page's newest state wins
      }
      for (const data of latest.values()) await apply(data);
      return pageFailed();
    });
  } else {
    await eachPage(api, '/subscriptions?per_page=200', opts.pager, 1000, async (items) => {
      for (const data of items) await apply(data);
      return pageFailed();
    });
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
  /**
   * Since v0.8.0: entities that could not be judged (no valid `updated_at` / `created_at`), so they were neither
   * replayed nor skipped as old. Never silent: `recoverBilling` reports the run incomplete and keeps its checkpoint.
   */
  invalid: number;
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
/** Paddle keeps events 90 days; a window inside 89 days is read from the event stream (one day of margin). */
const EVENT_STREAM_WINDOW_MS = 89 * 24 * 3_600_000;
const SUBSCRIPTION_EVENTS = ['activated', 'canceled', 'created', 'imported', 'past_due', 'paused', 'resumed', 'trialing', 'updated']
  .map((t) => `subscription.${t}`).join(',');

export async function reconcilePayments(
  billing: Billing,
  opts: {
    apiKey: string; since: Date | string; fetch?: FetchLike; signal?: AbortSignal;
    /** Since v0.8.7: the window's end (exclusive); `resume` continues a recovery run (`transactions` then `adjustments`). */
    until?: Date | string;
    resume?: { phase: 'transactions' | 'adjustments'; cursor: string | null; save(phase: 'transactions' | 'adjustments', next: string | null): Promise<void>; fail(): void };
  },
): Promise<{ transactions: PaymentCounts; adjustments: PaymentCounts }> {
  const process = processorOf(billing);
  if (!process) throw new Error('paddle-kit: reconcilePayments needs a billing made by createBilling');
  const since = new Date(opts.since);
  if (Number.isNaN(since.getTime())) throw new Error('paddle-kit: reconcilePayments needs a valid `since`');
  const api = apiFor(billing, opts);
  const counts = (): PaymentCounts => ({ scanned: 0, applied: 0, duplicates: 0, notOurs: 0, failed: 0, invalid: 0 });
  // An entity's time, or null when it has none valid: then it is counted invalid, never compared (NaN >= x is false).
  const timeOf = (e: Json): string | null => {
    const at = typeof e.updated_at === 'string' ? e.updated_at : e.created_at;
    return typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : null;
  };
  const tally = (c: PaymentCounts, r: ProcessResult | null) => {
    if (!r || r.outcome === 'failed' || r.outcome === 'in_progress') c.failed++;
    else if (r.outcome === 'duplicate') c.duplicates++;
    else if (r.reason === 'not_ours') c.notOurs++;
    else c.applied++;
  };
  const replay = (eventId: string, eventType: string, data: Json, at: string) => {
    opts.signal?.throwIfAborted();
    const ev = parseEvent({ event_id: eventId, event_type: eventType, occurred_at: at, data });
    return ev ? process(ev) : Promise.resolve(null);
  };
  const replayTransaction = async (tx: Json) => {
    const at = timeOf(tx);
    if (at === null) transactions.invalid++;
    else tally(transactions, await replay(`reconcile_txn_${tx.id}`, 'transaction.completed', tx, at));
  };

  const transactions = counts();
  const adjustments = counts();
  const sinceParam = encodeURIComponent(since.toISOString());
  const until = opts.until === undefined ? null : new Date(opts.until);
  const r = opts.resume;
  const bad = (c: PaymentCounts) => c.failed + c.invalid;
  // A page "failed" when one of its items failed or was invalid (the counters moved).
  const watch = () => { let before = bad(transactions) + bad(adjustments); return () => { const now = bad(transactions) + bad(adjustments); const b = now > before; before = now; return b; }; };

  if (r?.phase !== 'adjustments') {
    const failed = watch();
    const lt = until ? `&updated_at%5BLT%5D=${encodeURIComponent(until.toISOString())}` : '';
    const pager: Pager | undefined = r && { cursor: r.cursor, save: (n) => r.save(n ? 'transactions' : 'adjustments', n), fail: r.fail };
    await eachPage(api, `/transactions?status=completed&updated_at%5BGTE%5D=${sinceParam}${lt}&order_by=updated_at%5BASC%5D&per_page=30`, pager, 1000, async (items) => {
      for (const tx of items) {
        transactions.scanned++;
        await replayTransaction(tx);
      }
      return failed();
    });
  }

  const replayAdjustment = async (adj: Json, at: string) => {
    opts.signal?.throwIfAborted();
    adjustments.scanned++;
    if (billing.store.getTransaction && typeof adj.transaction_id === 'string' && !(await billing.store.getTransaction(adj.transaction_id))) {
      try {
        const tx = (await api.call('GET', `/transactions/${encodeURIComponent(adj.transaction_id)}`)).data as Json;
        if (tx?.status === 'completed') await replayTransaction(tx);
      } catch (error) {
        if (!(error instanceof PaddleError && error.status === 404)) throw error;
      }
    }
    tally(adjustments, await replay(`reconcile_adj_${adj.id}_${adj.status}`, 'adjustment.updated', adj, at));
  };
  // Validated before the date filter: an adjustment without a valid time is counted invalid, never dropped as "old".
  const replayPage = async (candidates: Json[]) => {
    const recent: Array<{ adj: Json; at: string }> = [];
    for (const adj of candidates) {
      const at = timeOf(adj);
      if (at === null) {
        adjustments.scanned++;
        adjustments.invalid++;
      } else if (Date.parse(at) >= since.getTime()) recent.push({ adj, at });
    }
    recent.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (const { adj, at } of recent) await replayAdjustment(adj, at);
  };
  // GET /adjustments has no date filter. Since v0.8.6, a window Paddle's event stream still holds (it keeps 90 days)
  // is read from adjustment events since `since` instead: a recovery run reads only what changed since its checkpoint.
  // Each page's newest event per adjustment wins (events come oldest first; a status replays once). An older window
  // (a first run, a long outage) reads the whole list (up to 200 pages of 50) as before. Page by page since v0.8.7.
  // ponytail: the full read stays for > 89-day windows; filter by `transaction_id` in batches past 10,000 adjustments.
  const failed = watch();
  const pager: Pager | undefined = r && { cursor: r.phase === 'adjustments' ? r.cursor : null, save: (n) => r.save('adjustments', n), fail: r.fail };
  if (Date.now() - since.getTime() <= EVENT_STREAM_WINDOW_MS) {
    const to = until ? `&to=${encodeURIComponent(until.toISOString())}` : '';
    await eachPage(api, `/events?event_type=adjustment.created,adjustment.updated&from=${sinceParam}${to}&order_by=id%5BASC%5D&per_page=200`, pager, 200, async (items) => {
      const latest = new Map<string, Json>();
      for (const e of items) {
        const data = e?.data as Json | undefined;
        if (data && typeof data.id === 'string') latest.set(data.id, data);
      }
      await replayPage([...latest.values()]);
      return failed();
    });
  } else {
    await eachPage(api, '/adjustments?per_page=50', pager, 200, async (items) => {
      await replayPage(items);
      return failed();
    });
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

/**
 * What an incomplete run did, so the reason is visible (since v0.8.0): failed replays, `invalid` records (no valid
 * time: a person looks), unfinished events still waiting, and no owned ids found (`ownership` all zero).
 */
export interface IncompleteDetail {
  subscriptions: Awaited<ReturnType<typeof reconcile>>;
  payments: Awaited<ReturnType<typeof reconcilePayments>>;
  events: { applied: number; failed: number };
  remainingPending: number;
  ownership?: { priceIds: number; productIds: number };
}

export type RecoveryResult =
  | { status: 'busy' }
  | ({ status: 'failed'; reason: 'incomplete' | 'timeout' | 'recovery_error' | 'api_error' | 'network' | 'circuit_open'; httpStatus?: number }
    & Partial<IncompleteDetail>)
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
  let partial: IncompleteDetail | undefined;
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
    // An interrupted run's window (since v0.8.7) is continued where it stopped, unless a later run already covered it
    // or it is over a day old (then a fresh window from the checkpoint reads the same ground).
    const saved = store.getRecoveryProgress && store.saveRecoveryProgress ? await store.getRecoveryProgress(name) : null;
    const resume = saved && startedAt.getTime() - Date.parse(saved.to) <= 86_400_000
      && (!state?.checkpointAt || Date.parse(saved.to) > Date.parse(state.checkpointAt)) ? saved : null;
    const since = resume ? new Date(resume.from)
      : new Date(Math.max(initial.getTime(), state?.checkpointAt ? Date.parse(state.checkpointAt) - overlapMs : initial.getTime()));
    const until = resume ? new Date(resume.to) : startedAt;
    let held = false; // a page had a failed item: progress stays at it, so the next run retries it
    const save = async (phase: RecoveryProgress['phase'], cursor: string | null) => {
      controller.signal.throwIfAborted();
      if (held || !store.saveRecoveryProgress) return;
      const ok = await store.saveRecoveryProgress({ name, runId, progress: { from: since.toISOString(), to: until.toISOString(), phase, cursor } });
      if (!ok) throw new Error('recovery lease lost');
    };
    const fail = () => { held = true; };
    await save(resume?.phase ?? 'subscriptions', resume?.cursor ?? null);
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
    const subscriptions = !resume || resume.phase === 'subscriptions'
      ? await reconcile(billing, { ...common, since, until, pager: { cursor: resume?.cursor ?? null, save: (n) => save(n ? 'subscriptions' : 'transactions', n), fail } })
      : { scanned: 0, applied: 0, notOurs: 0, invalid: 0 };
    const paymentsAt: { phase: 'transactions' | 'adjustments'; cursor: string | null } = resume && resume.phase !== 'subscriptions'
      ? { phase: resume.phase, cursor: resume.cursor } : { phase: 'transactions', cursor: null };
    const payments = await reconcilePayments(billing, { ...common, since, until, resume: { phase: paymentsAt.phase, cursor: paymentsAt.cursor, save, fail } });
    controller.signal.throwIfAborted();
    const remaining = await store.getPendingEvents({ before: new Date(startedAt.getTime() - pendingAgeMs).toISOString(), limit: 1 });
    controller.signal.throwIfAborted();
    incomplete = noOwnedIds || subscriptions.invalid > 0 || events.failed > 0 || remaining.length > 0
      || payments.transactions.failed > 0 || payments.adjustments.failed > 0
      || payments.transactions.invalid > 0 || payments.adjustments.invalid > 0;
    if (incomplete) {
      partial = { subscriptions, payments, events, remainingPending: remaining.length, ...(ownership ? { ownership } : {}) };
      throw new Error('incomplete recovery');
    }
    // Cleared first: finishing ends the lease the clear needs. A failed finish then just starts a fresh window.
    if (store.saveRecoveryProgress && !(await store.saveRecoveryProgress({ name, runId, progress: null }))) throw new Error('recovery lease lost');
    completed = await store.finishRecovery({ name, runId, status: 'succeeded', finishedAt: now().toISOString(), reason: null, checkpointAt: until.toISOString() });
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
    return { status: 'failed', reason, ...(error instanceof PaddleError && error.status !== undefined ? { httpStatus: error.status } : {}), ...(incomplete ? partial : {}) };
  }
}

export interface RecoveryRouteOptions {
  /** `null` when billing is off or misconfigured. */
  billing: Billing | null;
  /** `problems` from `readBillingEnv` / `billingFromEnv`. */
  problems: readonly string[];
  /** `config.apiKey` (PADDLE_API_KEY). */
  apiKey: string | undefined;
  /** `process.env.CRON_SECRET`. Unset or empty: every call is refused, so a missing secret never opens the job. */
  cronSecret: string | undefined;
  /** Passed to `recoverBilling` (limits, `fetch`, `now`). */
  recovery?: Omit<RecoveryOptions, 'apiKey'>;
  /**
   * Since v0.8.6: runs after recovery (also when it failed), e.g. `() => drainOutbox(query, handlers)` from
   * paddle-kit/fulfil. Its result is in the response as `outbox`; a throw is reported as `outbox: { error }` and makes
   * the response 500, so the cron log shows it.
   */
  drainOutbox?: () => Promise<unknown>;
}

/**
 * The scheduled recovery job as a route (since v0.8.1):
 * `export const { GET } = createRecoveryRoute({ billing, problems, apiKey: config?.apiKey, cronSecret: process.env.CRON_SECRET })`.
 * - `Authorization` must be `Bearer <cronSecret>` (Vercel Cron sends it); otherwise, or with no secret set, 401.
 * - Billing deliberately off (no billing variable, `problems` empty): 200 `{ status: "off" }`.
 * - Misconfigured (`problems`, or billing on without an API key): 500 `{ status: "misconfigured", problems }`, names only.
 * - Otherwise `recoverBilling`: 500 when the run failed, 200 when it is done or another run holds the lease.
 */
export function createRecoveryRoute(opts: RecoveryRouteOptions) {
  return {
    GET: async (req: Request): Promise<Response> => {
      const secret = opts.cronSecret;
      if (!secret || !(await safeEqual(req.headers.get('authorization') ?? '', `Bearer ${secret}`))) return new Response(null, { status: 401 });
      if (!opts.billing) {
        if (opts.problems.length === 0) return Response.json({ status: 'off' });
        return Response.json({ status: 'misconfigured', problems: [...opts.problems] }, { status: 500 });
      }
      if (!opts.apiKey) return Response.json({ status: 'misconfigured', problems: ['PADDLE_API_KEY is missing'] }, { status: 500 });
      const result = await recoverBilling(opts.billing, { ...opts.recovery, apiKey: opts.apiKey });
      if (!opts.drainOutbox) return Response.json(result, { status: result.status === 'failed' ? 500 : 200 });
      let outbox: unknown;
      let outboxFailed = false;
      try {
        outbox = await opts.drainOutbox();
      } catch (error) {
        outboxFailed = true;
        outbox = { error: (error as Error)?.name ?? 'Error' }; // the name only: a driver message may hold a secret
      }
      return Response.json({ ...result, outbox }, { status: result.status === 'failed' || outboxFailed ? 500 : 200 });
    },
  };
}
