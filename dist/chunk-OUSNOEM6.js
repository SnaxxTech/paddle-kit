import {
  customDataOf,
  itemsOf,
  parseEvent
} from "./chunk-UYGU5JF5.js";
import {
  version
} from "./chunk-FTSZ3KWT.js";
import {
  safeEqual,
  verifySignature
} from "./chunk-74Z3S4IU.js";

// src/core/access.ts
var DAY_MS = 864e5;
function grantsAccess(sub, now, graceDays) {
  switch (sub.status) {
    case "active":
    case "trialing":
      return true;
    case "past_due":
      if (!sub.pastDueSince) return true;
      return now.getTime() - Date.parse(sub.pastDueSince) <= graceDays * DAY_MS;
    default:
      return false;
  }
}
function decideAccess(subs, feature, policy, now) {
  return subs.some(
    (s) => grantsAccess(s, now, policy.pastDueGraceDays) && s.priceIds.some((p) => Object.hasOwn(policy.entitlements, p) && policy.entitlements[p].includes(feature))
  );
}
function nextPastDueSince(prev, status, occurredAt) {
  if (status !== "past_due") return null;
  if (prev?.status === "past_due" && prev.pastDueSince) return prev.pastDueSince;
  return occurredAt;
}

// src/core/owns.ts
var isOwnsResolver = (owns) => typeof owns === "object" && owns !== null && typeof owns.resolve === "function";
function ownershipPredicate(owns) {
  if (owns === void 0) return null;
  if (typeof owns === "function") return owns;
  const prices = new Set(owns.priceIds ?? []);
  const products = new Set(owns.productIds ?? []);
  if (prices.size === 0 && products.size === 0) {
    throw new Error("paddle-kit: owns needs at least one priceId or productId (an empty list would ignore every event)");
  }
  return ({ items }) => items.some((i) => prices.has(i.priceId) || i.productId !== null && products.has(i.productId));
}
async function resolveOwnership(owns) {
  if (!isOwnsResolver(owns)) return ownershipPredicate(owns);
  return ownershipPredicate(await owns.resolve() ?? {});
}

// src/core/handler.ts
var MAX_WEBHOOK_BODY_BYTES = 4e6;
async function readBody(req, max) {
  if (Number(req.headers.get("content-length")) > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks = [];
  let size = 0;
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    size += r.value.byteLength;
    if (size > max) {
      reader.cancel().catch(() => {
      });
      return null;
    }
    chunks.push(r.value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
var Failure = class extends Error {
  constructor(reason, original) {
    super(reason);
    this.reason = reason;
    this.original = original;
  }
  reason;
  original;
};
var TimeoutError = class extends Error {
  name = "TimeoutError";
};
function within(p, ms, what) {
  if (!ms) return p;
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${what} took longer than ${ms} ms`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
function timedStore(store, ms) {
  if (!ms) return store;
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args) => within(Promise.resolve(value.apply(target, args)), ms, `store.${String(prop)}`);
    }
  });
}
function report(onError, error, ctx) {
  if (!onError) return;
  try {
    void Promise.resolve(onError(error, ctx)).catch(() => {
    });
  } catch {
  }
}
function unverifiedCounter(log, now) {
  const stats = { since: now().toISOString(), count: 0, byReason: {}, lastAt: null, lastReason: null };
  let loggedAt = Number.NEGATIVE_INFINITY;
  let unlogged = 0;
  return {
    add(reason) {
      const at = now();
      stats.count++;
      stats.byReason[reason] = (stats.byReason[reason] ?? 0) + 1;
      stats.lastAt = at.toISOString();
      stats.lastReason = reason;
      unlogged++;
      if (at.getTime() - loggedAt >= 6e4) {
        log({ level: "warn", reason, count: unlogged });
        loggedAt = at.getTime();
        unlogged = 0;
      }
    },
    stats: () => ({ ...stats, byReason: { ...stats.byReason } })
  };
}
var QUIET = /* @__PURE__ */ new Set(["unknown_event", "not_ours", "unmatched", "mirrored"]);
var json = (body, status) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
var IN_PROGRESS = { http: 409, body: { error: "in_progress" }, outcome: "in_progress", reason: null };
function createWebhookHandler(d) {
  const unverified = d.unverified ?? unverifiedCounter(d.log, d.now);
  function refuse(reason, status) {
    unverified.add(reason);
    return json({ error: reason }, status);
  }
  async function reject(reason, status) {
    d.log({ level: "warn", reason });
    try {
      await d.store.recordFailure(reason, d.now());
    } catch (error) {
      d.log({ level: "error", reason: "store_error" });
      report(d.onError, error, { reason: "store_error" });
    }
    return json({ error: reason }, status);
  }
  async function runHook(hook) {
    if (!hook) return;
    try {
      await within(Promise.resolve().then(hook), d.hookTimeoutMs, "hook");
    } catch (error) {
      throw new Failure("hook_error", error);
    }
  }
  const NOT_OURS = { status: "ignored", reason: "not_ours" };
  async function matches(x) {
    const owns = d.owns;
    if (!owns) return true;
    let predicate;
    if (typeof owns === "function") predicate = owns;
    else {
      try {
        predicate = ownershipPredicate(await within(Promise.resolve().then(() => owns.resolve()), d.hookTimeoutMs, "owns.resolve") ?? {});
      } catch (error) {
        throw new Failure("prices_unavailable", error);
      }
    }
    try {
      return predicate(x) === true;
    } catch (error) {
      throw new Failure("hook_error", error);
    }
  }
  async function apply(ev) {
    switch (ev.kind) {
      case "subscription": {
        const prev = await d.store.getSubscription(ev.subscription.subscriptionId);
        const ours = await matches({ kind: "subscription", items: itemsOf(ev.subscription), customData: customDataOf(ev.subscription) });
        if (!prev && !ours) return NOT_OURS;
        const pastDueSince = nextPastDueSince(prev, ev.subscription.status, ev.occurredAt);
        const { applied } = d.store.applySubscription ? await d.store.applySubscription(ev.subscription) : await d.store.upsertSubscription({ ...ev.subscription, pastDueSince });
        if (!applied) {
          return { status: "stale", reason: "out_of_order" };
        }
        if (!ours) return { status: "processed", reason: "mirrored" };
        return { status: "processed", reason: ev.subscription.userId ? null : "no_user_id" };
      }
      case "transaction": {
        const tx = ev.transaction;
        const ours = await matches({ kind: "transaction", items: tx.items, customData: tx.customData });
        const owned = ours || tx.subscriptionId !== null && await d.store.getSubscription(tx.subscriptionId) !== null;
        await d.store.recordTransaction?.({
          transactionId: tx.transactionId,
          owned,
          subscriptionId: tx.subscriptionId,
          customerId: tx.customerId,
          occurredAt: tx.occurredAt,
          receivedAt: d.now().toISOString()
        });
        if (!owned) return NOT_OURS;
        if (ev.eventType === "transaction.completed") {
          const ctx = { eventId: ev.eventId, eventType: ev.eventType, store: d.store };
          await runHook(d.onTransaction && (() => d.onTransaction(ev.transaction, ctx)));
        }
        return { status: "processed", reason: ours ? null : "mirrored" };
      }
      case "adjustment": {
        const adj = ev.adjustment;
        const seen = await d.store.getTransaction?.(adj.transactionId) ?? null;
        const sub = adj.subscriptionId === null ? null : await d.store.getSubscription(adj.subscriptionId);
        const onOurSubscription = sub !== null;
        if (seen && !seen.owned && !onOurSubscription) return NOT_OURS;
        const ctx = { eventId: ev.eventId, eventType: ev.eventType, store: d.store, known: seen?.owned === true || onOurSubscription };
        const ours = sub ? await matches({ kind: "subscription", items: itemsOf(sub), customData: customDataOf(sub) }) : seen?.owned === true;
        await runHook(d.onAdjustment && (() => d.onAdjustment(ev.adjustment, ctx)));
        return { status: "processed", reason: !ctx.known ? "unmatched" : ours ? null : "mirrored" };
      }
      case "ignored":
        return { status: "ignored", reason: "unknown_event" };
    }
  }
  async function process(ev) {
    const tag = { eventId: ev.eventId, eventType: ev.eventType };
    let recorded = false;
    const claimToken = crypto.randomUUID();
    try {
      const at = d.now();
      const leaseExpiredBefore = new Date(at.getTime() - (d.leaseSeconds ?? 60) * 1e3).toISOString();
      const claim = await d.store.recordEvent({ ...tag, occurredAt: ev.occurredAt, receivedAt: at.toISOString(), leaseExpiredBefore, claimToken });
      if (claim.alreadyDone) return { http: 200, body: { received: true, duplicate: true }, outcome: "duplicate", reason: null };
      if (claim.inProgress) return IN_PROGRESS;
      recorded = true;
      const outcome = await apply(ev);
      if (await d.store.markEvent(ev.eventId, outcome.status, outcome.reason, claimToken) === false) return IN_PROGRESS;
      if (outcome.reason && !QUIET.has(outcome.reason)) d.log({ level: "warn", reason: outcome.reason, ...tag });
      return { http: 200, body: { received: true }, outcome: outcome.status, reason: outcome.reason };
    } catch (err) {
      const reason = err instanceof Failure ? err.reason : "store_error";
      d.log({ level: "error", reason, ...tag });
      report(d.onError, err instanceof Failure ? err.original : err, { reason, ...tag });
      try {
        if (!recorded) throw new Error("event row never written");
        if (await d.store.markEvent(ev.eventId, "failed", reason, claimToken) === false) await d.store.recordFailure(reason, d.now());
      } catch {
        if (reason !== "store_error") d.log({ level: "error", reason: "store_error", ...tag });
        try {
          await d.store.recordFailure(reason, d.now());
        } catch {
        }
      }
      return { http: reason === "prices_unavailable" ? 503 : 500, body: { error: reason }, outcome: "failed", reason };
    }
  }
  async function handle(req) {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    let rawBody;
    try {
      rawBody = await readBody(req, d.maxBodyBytes ?? MAX_WEBHOOK_BODY_BYTES);
    } catch {
      return refuse("missing_body", 400);
    }
    if (rawBody === null) return refuse("body_too_large", 413);
    if (!rawBody) return refuse("missing_body", 400);
    const verified = await verifySignature({
      rawBody,
      header: req.headers.get("paddle-signature"),
      secret: d.secret,
      toleranceSeconds: d.toleranceSeconds,
      futureSkewSeconds: d.futureSkewSeconds,
      now: d.now().getTime()
    });
    if (!verified.ok) return refuse(verified.reason, verified.reason === "bad_signature_header" ? 400 : 401);
    let parsed;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return reject("bad_json", 400);
    }
    const ev = parseEvent(parsed);
    if (!ev) return reject("bad_payload", 400);
    const result = await process(ev);
    return json(result.body, result.http);
  }
  return Object.assign(handle, { process });
}

// src/core/billing.ts
var processors = /* @__PURE__ */ new WeakMap();
var processorOf = (billing) => processors.get(billing);
var defaultLog = (entry) => console[entry.level](JSON.stringify({ source: "paddle-kit", ...entry }));
function createBilling(config) {
  const secrets = typeof config.webhookSecret === "string" ? [config.webhookSecret] : [...config.webhookSecret ?? []];
  if (secrets.length === 0 || secrets.some((s) => typeof s !== "string" || !s)) throw new Error("paddle-kit: webhookSecret is required");
  const nodeEnv = globalThis.process?.env?.NODE_ENV;
  if (config.environment === "production" && nodeEnv !== void 0 && nodeEnv !== "production" && !config.allowProductionInDev) {
    throw new Error('paddle-kit: environment "production" outside NODE_ENV=production; pass allowProductionInDev: true if intended');
  }
  const now = config.now ?? (() => /* @__PURE__ */ new Date());
  const log = config.log ?? defaultLog;
  const policy = { entitlements: config.entitlements, pastDueGraceDays: config.pastDueGraceDays ?? 7 };
  const owns = isOwnsResolver(config.owns) ? config.owns : ownershipPredicate(config.owns);
  const store = timedStore(config.store, config.storeTimeoutMs);
  const unverified = unverifiedCounter(log, now);
  const handleWebhook = createWebhookHandler({
    owns,
    store,
    secret: secrets,
    toleranceSeconds: 5,
    futureSkewSeconds: config.clockSkewSeconds ?? 60,
    leaseSeconds: config.eventLeaseSeconds,
    log,
    now,
    onTransaction: config.onTransaction,
    onAdjustment: config.onAdjustment,
    maxBodyBytes: config.maxBodyBytes,
    onError: config.onError,
    hookTimeoutMs: config.hookTimeoutMs,
    unverified
  });
  async function runCheck(name, check) {
    const ms = config.healthCheckTimeoutMs ?? 3e3;
    try {
      const result = await within(Promise.resolve().then(check), ms, `health check ${name}`);
      if (typeof result?.ok !== "boolean") return { ok: false, detail: "returned no { ok } result" };
      return typeof result.detail === "string" ? { ok: result.ok, detail: result.detail } : { ok: result.ok };
    } catch (error) {
      report(config.onError, error, { reason: "health_check", check: name });
      return { ok: false, detail: error?.name === "TimeoutError" ? `no answer in ${ms} ms` : "threw an error" };
    }
  }
  const { webhookSecret: _omitted, ...publicConfig } = config;
  const billing = {
    config: publicConfig,
    store: config.store,
    handleWebhook,
    async handleHealth(req) {
      if (!config.healthToken) return new Response(null, { status: 404 });
      if (!await safeEqual(req.headers.get("authorization") ?? "", `Bearer ${config.healthToken}`)) return new Response(null, { status: 401 });
      const checks = config.healthChecks ? Promise.all(Object.entries(config.healthChecks).map(async ([name, check]) => [name, await runCheck(name, check)])) : null;
      try {
        const at = now();
        const body = { ...await store.health(at), kitVersion: version, environment: config.environment, unverified: unverified.stats() };
        if (store.recovery) {
          const r = await within(store.recovery.getRecovery(config.environment), config.storeTimeoutMs, "store.recovery.getRecovery");
          body.recovery = r && {
            name: r.name,
            status: r.status,
            reason: r.reason,
            lastSucceededAt: r.lastSucceededAt,
            checkpointAt: r.checkpointAt,
            checkpointAgeSeconds: r.checkpointAt ? Math.max(0, Math.floor((at.getTime() - Date.parse(r.checkpointAt)) / 1e3)) : null
          };
        }
        if (checks) body.checks = Object.fromEntries(await checks);
        return Response.json(body);
      } catch (error) {
        log({ level: "error", reason: "store_error" });
        report(config.onError, error, { reason: "store_error" });
        return Response.json({ error: "store_error" }, { status: 503 });
      }
    },
    async hasAccess(userId, feature) {
      if (!userId) return false;
      return decideAccess(await store.getSubscriptionsByUser(userId), feature, policy, now());
    }
  };
  processors.set(billing, handleWebhook.process);
  return billing;
}

// src/core/transport.ts
var PaddleTransportError = class extends Error {
  constructor(code, retryAt = null) {
    super(`Paddle API ${code}`);
    this.code = code;
    this.retryAt = retryAt;
  }
  code;
  retryAt;
  name = "PaddleTransportError";
};
var transient = (status) => [408, 429, 500, 502, 503, 504].includes(status);
function positive(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`paddle-kit: ${name} must be a positive integer`);
  return value;
}
function retryDelay(value) {
  if (!value) return null;
  const ms = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1e3 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}
async function pause(ms, signal) {
  if (signal?.aborted) throw new PaddleTransportError("aborted");
  await new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new PaddleTransportError("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
function createPaddleTransport(opts = {}) {
  const timeoutMs = positive(opts.requestTimeoutMs ?? 4e3, "requestTimeoutMs");
  const budgetMs = positive(opts.budgetMs ?? 1e4, "budgetMs");
  const threshold = positive(opts.failureThreshold ?? 3, "failureThreshold");
  const cooldownMs = positive(opts.cooldownMs ?? 3e4, "cooldownMs");
  const maxRetries = opts.maxRetries ?? 2;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) throw new Error("paddle-kit: maxRetries must be between 0 and 10");
  const rawFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  let failures = 0;
  let until = null;
  let probing = false;
  let generation = 0;
  function open(delay) {
    until = Math.max(until ?? 0, Date.now() + delay);
    generation++;
  }
  async function attempt(url, init, remaining) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    init.signal?.addEventListener("abort", abort, { once: true });
    let timer;
    const cancelled = new Promise((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new PaddleTransportError(timedOut ? "timeout" : "aborted")), { once: true });
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, Math.min(timeoutMs, remaining));
      if (init.signal?.aborted) controller.abort();
    });
    try {
      const work = (async () => {
        const response = await rawFetch(url, { ...init, signal: controller.signal, redirect: "error" });
        let payload;
        let malformed = false;
        try {
          payload = await response.json();
        } catch {
          malformed = true;
        }
        if (response.ok && malformed) throw new PaddleTransportError("invalid_response");
        return { ok: response.ok, status: response.status, headers: response.headers, json: async () => payload };
      })();
      return await Promise.race([work, cancelled]);
    } catch (error) {
      if (error instanceof PaddleTransportError) throw error;
      throw new PaddleTransportError("network");
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", abort);
    }
  }
  const fetchImpl = async (url, init) => {
    const target = new URL(url);
    if (!["https://api.paddle.com", "https://sandbox-api.paddle.com"].includes(target.origin) || target.username || target.password) {
      throw new Error("paddle-kit: transport only accepts Paddle API URLs");
    }
    if (init.signal?.aborted) throw new PaddleTransportError("aborted");
    let probe = false;
    if (until !== null) {
      if (Date.now() < until || probing) throw new PaddleTransportError("circuit_open", until);
      probing = true;
      probe = true;
      generation++;
    }
    let ticket = generation;
    const deadline = Date.now() + budgetMs;
    const retries = init.method.toUpperCase() === "GET" ? maxRetries : 0;
    try {
      for (let n = 0; ; n++) {
        let response;
        let failure;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new PaddleTransportError("timeout");
        try {
          response = await attempt(url, init, remaining);
        } catch (error) {
          failure = error;
        }
        if (failure?.code === "aborted") throw failure;
        const retryable = failure !== void 0 || response !== void 0 && transient(response.status);
        const providerDelay = retryDelay(response?.headers?.get("retry-after"));
        if (response?.status === 429) {
          open(providerDelay ?? cooldownMs);
          ticket = generation;
          probing = true;
          probe = true;
        }
        if (!retryable) {
          if (ticket === generation) {
            failures = 0;
            until = null;
          }
          return response;
        }
        const backoff = Math.floor(200 * 2 ** n * (0.5 + Math.random() * 0.5));
        const delay = providerDelay ?? backoff;
        if (n < retries && delay < deadline - Date.now()) {
          await pause(delay, init.signal);
          continue;
        }
        if (ticket === generation) {
          failures++;
          if (probe || failures >= threshold) open(Math.max(cooldownMs, providerDelay ?? 0));
        }
        if (failure) throw failure;
        return response;
      }
    } finally {
      if (probe) probing = false;
    }
  };
  return {
    fetch: fetchImpl,
    state: () => ({ state: until === null ? "closed" : probing ? "half_open" : "open", consecutiveFailures: failures, retryAt: until === null ? null : new Date(until).toISOString() })
  };
}

export {
  nextPastDueSince,
  isOwnsResolver,
  resolveOwnership,
  MAX_WEBHOOK_BODY_BYTES,
  within,
  processorOf,
  createBilling,
  PaddleTransportError,
  createPaddleTransport
};
