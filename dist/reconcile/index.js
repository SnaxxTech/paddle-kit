import {
  LIVE_BASE,
  PaddleError,
  SANDBOX_BASE,
  paddleClient
} from "../chunk-KBHAKEOL.js";
import {
  PaddleTransportError,
  nextPastDueSince,
  processorOf,
  resolveOwnership,
  within
} from "../chunk-INBE6URD.js";
import {
  customDataOf,
  itemsOf,
  parseEvent,
  subscriptionFrom
} from "../chunk-UYGU5JF5.js";
import "../chunk-J3OBH2AV.js";
import {
  safeEqual
} from "../chunk-74Z3S4IU.js";

// src/reconcile/index.ts
async function reconcile(billing, opts) {
  const api = apiFor(billing, opts);
  const owns = await resolveOwnership(billing.config.owns);
  let scanned = 0;
  let applied = 0;
  let notOurs = 0;
  let invalid = 0;
  for (const data of await api.list("/subscriptions?per_page=200", 1e3)) {
    opts.signal?.throwIfAborted();
    scanned++;
    const sub = subscriptionFrom(data, typeof data.updated_at === "string" ? data.updated_at : "");
    if (!sub || Number.isNaN(Date.parse(sub.lastEventAt))) {
      invalid++;
      continue;
    }
    const prev = await billing.store.getSubscription(sub.subscriptionId);
    if (owns && !prev && !owns({ kind: "subscription", items: itemsOf(sub), customData: customDataOf(sub) })) {
      notOurs++;
      continue;
    }
    const result = billing.store.applySubscription ? await billing.store.applySubscription(sub) : await billing.store.upsertSubscription({ ...sub, pastDueSince: nextPastDueSince(prev, sub.status, sub.lastEventAt) });
    if (result.applied) applied++;
  }
  return { scanned, applied, notOurs, invalid };
}
function apiFor(billing, opts) {
  const keyEnv = opts.apiKey.startsWith("pdl_sdbx_") ? "sandbox" : opts.apiKey.startsWith("pdl_live_") ? "production" : null;
  if (keyEnv !== billing.config.environment) {
    throw new Error(`paddle-kit: API key does not match environment "${billing.config.environment}"`);
  }
  const base = billing.config.environment === "production" ? LIVE_BASE : SANDBOX_BASE;
  return paddleClient(base, opts.apiKey, opts.fetch ?? billing.config.paddleFetch ?? ((url, init) => fetch(url, init)), [opts.apiKey], opts.signal);
}
async function syncOwnership(billing, opts) {
  const store = billing.store;
  if (!store.addOwnedIds) throw new Error("paddle-kit: syncOwnership needs a store with addOwnedIds (built-in stores: migration 004)");
  const api = apiFor(billing, opts);
  const prices = /* @__PURE__ */ new Set();
  const products = /* @__PURE__ */ new Set();
  for (const p of await api.list("/prices?status=active,archived&include=product&per_page=200", 50)) {
    opts.signal?.throwIfAborted();
    if (p.product?.custom_data?.paddle_kit !== opts.app || typeof p.id !== "string" || typeof p.product.id !== "string") continue;
    prices.add(p.id);
    products.add(p.product.id);
  }
  await store.addOwnedIds({ priceIds: [...prices].sort(), productIds: [...products].sort() }, (/* @__PURE__ */ new Date()).toISOString());
  return { priceIds: prices.size, productIds: products.size };
}
async function reconcilePayments(billing, opts) {
  const process = processorOf(billing);
  if (!process) throw new Error("paddle-kit: reconcilePayments needs a billing made by createBilling");
  const since = new Date(opts.since);
  if (Number.isNaN(since.getTime())) throw new Error("paddle-kit: reconcilePayments needs a valid `since`");
  const api = apiFor(billing, opts);
  const counts = () => ({ scanned: 0, applied: 0, duplicates: 0, notOurs: 0, failed: 0, invalid: 0 });
  const timeOf = (e) => {
    const at = typeof e.updated_at === "string" ? e.updated_at : e.created_at;
    return typeof at === "string" && Number.isFinite(Date.parse(at)) ? at : null;
  };
  const tally = (c, r) => {
    if (!r || r.outcome === "failed" || r.outcome === "in_progress") c.failed++;
    else if (r.outcome === "duplicate") c.duplicates++;
    else if (r.reason === "not_ours") c.notOurs++;
    else c.applied++;
  };
  const replay = (eventId, eventType, data, at) => {
    opts.signal?.throwIfAborted();
    const ev = parseEvent({ event_id: eventId, event_type: eventType, occurred_at: at, data });
    return ev ? process(ev) : Promise.resolve(null);
  };
  const replayTransaction = async (tx) => {
    const at = timeOf(tx);
    if (at === null) transactions.invalid++;
    else tally(transactions, await replay(`reconcile_txn_${tx.id}`, "transaction.completed", tx, at));
  };
  const transactions = counts();
  const sinceParam = encodeURIComponent(since.toISOString());
  for (const tx of await api.list(`/transactions?status=completed&updated_at%5BGTE%5D=${sinceParam}&order_by=updated_at%5BASC%5D&per_page=30`, 1e3)) {
    transactions.scanned++;
    await replayTransaction(tx);
  }
  const adjustments = counts();
  const recent = [];
  for (const adj of await api.list("/adjustments?per_page=50", 200)) {
    const at = timeOf(adj);
    if (at === null) {
      adjustments.scanned++;
      adjustments.invalid++;
    } else if (Date.parse(at) >= since.getTime()) recent.push({ adj, at });
  }
  recent.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const { adj, at } of recent) {
    opts.signal?.throwIfAborted();
    adjustments.scanned++;
    if (billing.store.getTransaction && typeof adj.transaction_id === "string" && !await billing.store.getTransaction(adj.transaction_id)) {
      try {
        const tx = (await api.call("GET", `/transactions/${encodeURIComponent(adj.transaction_id)}`)).data;
        if (tx?.status === "completed") await replayTransaction(tx);
      } catch (error) {
        if (!(error instanceof PaddleError && error.status === 404)) throw error;
      }
    }
    tally(adjustments, await replay(`reconcile_adj_${adj.id}_${adj.status}`, "adjustment.updated", adj, at));
  }
  return { transactions, adjustments };
}
async function recoverBilling(billing, opts) {
  const store = opts.store ?? billing.store.recovery;
  if (!store) throw new Error("paddle-kit: recovery needs a RecoveryStore (built-in stores require migration 003)");
  const timeoutMs = opts.timeoutMs ?? 45e3;
  const overlapMs = opts.overlapMs ?? 36e5;
  const pendingLimit = opts.pendingLimit ?? 100;
  const pendingAgeMs = opts.pendingAgeMs ?? 3e5;
  const initial = opts.initialSince ?? /* @__PURE__ */ new Date(0);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(overlapMs) || overlapMs < 0 || !Number.isSafeInteger(pendingLimit) || pendingLimit < 1 || !Number.isSafeInteger(pendingAgeMs) || pendingAgeMs < 0 || !Number.isFinite(initial.getTime())) throw new Error("paddle-kit: invalid recovery limits");
  const now = opts.now ?? (() => /* @__PURE__ */ new Date());
  const startedAt = now();
  const name = opts.name ?? billing.config.environment;
  const runId = crypto.randomUUID();
  const controller = new AbortController();
  let claimed = false;
  let incomplete = false;
  let completed = false;
  let partial;
  const work = async () => {
    claimed = await store.claimRecovery({ name, runId, startedAt: startedAt.toISOString(), leaseUntil: new Date(startedAt.getTime() + timeoutMs + 5e3).toISOString() });
    controller.signal.throwIfAborted();
    if (!claimed) return { status: "busy" };
    const state = await store.getRecovery(name);
    const app = billing.config.catalogApp;
    const ownership = app && billing.store.addOwnedIds ? await syncOwnership(billing, { apiKey: opts.apiKey, app, fetch: opts.fetch, signal: controller.signal }) : null;
    controller.signal.throwIfAborted();
    const noOwnedIds = ownership !== null && ownership.priceIds + ownership.productIds === 0 && ((await billing.store.getOwnedIds?.())?.priceIds.length ?? 0) === 0;
    const since = new Date(Math.max(initial.getTime(), state?.checkpointAt ? Date.parse(state.checkpointAt) - overlapMs : initial.getTime()));
    const api = apiFor(billing, { ...opts, signal: controller.signal });
    const process = processorOf(billing);
    if (!process) throw new Error("paddle-kit: recovery needs a billing made by createBilling");
    const ids = await store.getPendingEvents({ before: new Date(startedAt.getTime() - pendingAgeMs).toISOString(), limit: pendingLimit + 1 });
    const events = { applied: 0, failed: Math.max(0, ids.length - pendingLimit) };
    for (const pending of ids.slice(0, pendingLimit)) {
      const id = pending.eventId;
      controller.signal.throwIfAborted();
      if (!id.startsWith("evt_")) continue;
      try {
        const occurred = Date.parse(pending.occurredAt);
        const params = new URLSearchParams({ from: new Date(occurred - 6e4).toISOString(), to: new Date(occurred + 6e4).toISOString(), event_type: pending.eventType, per_page: "200" });
        const envelope = (await api.list(`/events?${params}`, 5)).find((e) => e.event_id === id);
        controller.signal.throwIfAborted();
        const event = parseEvent(envelope);
        if (!event || event.eventId !== id) {
          events.failed++;
          continue;
        }
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
    incomplete = noOwnedIds || subscriptions.invalid > 0 || events.failed > 0 || remaining.length > 0 || payments.transactions.failed > 0 || payments.adjustments.failed > 0 || payments.transactions.invalid > 0 || payments.adjustments.invalid > 0;
    if (incomplete) {
      partial = { subscriptions, payments, events, remainingPending: remaining.length, ...ownership ? { ownership } : {} };
      throw new Error("incomplete recovery");
    }
    completed = await store.finishRecovery({ name, runId, status: "succeeded", finishedAt: now().toISOString(), reason: null });
    if (!completed) throw new Error("recovery lease lost");
    return { status: "done", since: since.toISOString(), subscriptions, payments, events, ...ownership ? { ownership } : {} };
  };
  try {
    return await within(work(), timeoutMs, "billing recovery");
  } catch (error) {
    controller.abort();
    const reason = incomplete ? "incomplete" : error?.name === "TimeoutError" ? "timeout" : error instanceof PaddleTransportError && ["network", "timeout", "circuit_open"].includes(error.code) ? error.code : error instanceof PaddleError && error.status !== void 0 ? "api_error" : "recovery_error";
    if (claimed && !completed) {
      try {
        await within(store.finishRecovery({ name, runId, status: "failed", finishedAt: now().toISOString(), reason }), 2e3, "recovery status");
      } catch {
      }
    }
    return { status: "failed", reason, ...error instanceof PaddleError && error.status !== void 0 ? { httpStatus: error.status } : {}, ...incomplete ? partial : {} };
  }
}
function createRecoveryRoute(opts) {
  return {
    GET: async (req) => {
      const secret = opts.cronSecret;
      if (!secret || !await safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) return new Response(null, { status: 401 });
      if (!opts.billing) {
        if (opts.problems.length === 0) return Response.json({ status: "off" });
        return Response.json({ status: "misconfigured", problems: [...opts.problems] }, { status: 500 });
      }
      if (!opts.apiKey) return Response.json({ status: "misconfigured", problems: ["PADDLE_API_KEY is missing"] }, { status: 500 });
      const result = await recoverBilling(opts.billing, { ...opts.recovery, apiKey: opts.apiKey });
      return Response.json(result, { status: result.status === "failed" ? 500 : 200 });
    }
  };
}
export {
  createRecoveryRoute,
  reconcile,
  reconcilePayments,
  recoverBilling,
  syncOwnership
};
