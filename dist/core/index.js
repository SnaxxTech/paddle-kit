import {
  decideAccess,
  nextPastDueSince
} from "../chunk-47QH2E5T.js";

// src/core/events.ts
var SUBSCRIPTION_EVENT_TYPES = /* @__PURE__ */ new Set([
  "subscription.created",
  "subscription.imported",
  "subscription.updated",
  "subscription.activated",
  "subscription.trialing",
  "subscription.past_due",
  "subscription.paused",
  "subscription.resumed",
  "subscription.canceled"
]);
var CUSTOMER_EVENT_TYPES = /* @__PURE__ */ new Set(["customer.created", "customer.updated"]);
var RECORD_ONLY_EVENT_TYPES = /* @__PURE__ */ new Set(["transaction.completed"]);
var STATUSES = /* @__PURE__ */ new Set(["active", "trialing", "past_due", "paused", "canceled"]);
var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var isStr = (v) => typeof v === "string" && v.length > 0;
var isTime = (v) => isStr(v) && !Number.isNaN(Date.parse(v));
var hasControlChars = (v) => /[\u0000-\u001f\u007f-\u009f]/.test(v);
var optUserId = (v) => isStr(v) && !hasControlChars(v) ? v : null;
var optStr = (v) => isStr(v) ? v : null;
function parseEvent(json2) {
  if (!isObj(json2) || !isStr(json2.event_id) || !isStr(json2.event_type) || !isTime(json2.occurred_at) || !isObj(json2.data)) {
    return null;
  }
  const env = { eventId: json2.event_id, eventType: json2.event_type, occurredAt: json2.occurred_at };
  const data = json2.data;
  if (SUBSCRIPTION_EVENT_TYPES.has(env.eventType)) {
    if (!isStr(data.id) || !isStr(data.customer_id) || !STATUSES.has(data.status) || !Array.isArray(data.items)) return null;
    const priceIds = data.items.map((item) => item?.price?.id).filter(isStr);
    const sc = isObj(data.scheduled_change) && isStr(data.scheduled_change.action) && isTime(data.scheduled_change.effective_at) ? { action: data.scheduled_change.action, effectiveAt: data.scheduled_change.effective_at } : null;
    return {
      ...env,
      kind: "subscription",
      subscription: {
        subscriptionId: data.id,
        customerId: data.customer_id,
        userId: isObj(data.custom_data) ? optUserId(data.custom_data.userId) : null,
        status: data.status,
        priceIds,
        currentPeriodEnd: isObj(data.current_billing_period) ? optStr(data.current_billing_period.ends_at) : null,
        scheduledChange: sc,
        canceledAt: optStr(data.canceled_at),
        lastEventAt: env.occurredAt,
        raw: data
      }
    };
  }
  if (CUSTOMER_EVENT_TYPES.has(env.eventType)) {
    if (!isStr(data.id)) return null;
    return { ...env, kind: "customer", customer: { customerId: data.id, email: optStr(data.email), lastEventAt: env.occurredAt } };
  }
  if (RECORD_ONLY_EVENT_TYPES.has(env.eventType)) return { ...env, kind: "record-only" };
  return { ...env, kind: "ignored" };
}

// src/core/signature.ts
var encoder = new TextEncoder();
function parseSignatureHeader(header) {
  let ts;
  const h1 = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "ts" && /^\d+$/.test(value)) ts = Number(value);
    else if (key === "h1" && /^[0-9a-f]{64}$/i.test(value)) h1.push(value.toLowerCase());
  }
  return ts !== void 0 && h1.length > 0 ? { ts, h1 } : null;
}
async function verifySignature(input) {
  const parsed = input.header ? parseSignatureHeader(input.header) : null;
  if (!parsed) return { ok: false, reason: "bad_signature_header" };
  const key = await crypto.subtle.importKey("raw", encoder.encode(input.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${parsed.ts}:${input.rawBody}`)));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  if (!parsed.h1.some((candidate) => constantTimeEqual(candidate, expected))) {
    return { ok: false, reason: "signature_mismatch" };
  }
  const tolerance = input.toleranceSeconds ?? 5;
  const now = input.now ?? Date.now();
  if (now > (parsed.ts + tolerance) * 1e3) return { ok: false, reason: "stale_timestamp" };
  return { ok: true };
}
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// src/core/handler.ts
var json = (body, status) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function createWebhookHandler(d) {
  async function reject(reason, status) {
    d.log({ level: "warn", reason });
    try {
      await d.store.recordFailure(reason, d.now());
    } catch {
      d.log({ level: "error", reason: "store_error" });
    }
    return json({ error: reason }, status);
  }
  async function apply(ev) {
    switch (ev.kind) {
      case "subscription": {
        const prev = await d.store.getSubscription(ev.subscription.subscriptionId);
        const pastDueSince = nextPastDueSince(prev, ev.subscription.status, ev.occurredAt);
        const { applied } = await d.store.upsertSubscription({ ...ev.subscription, pastDueSince });
        if (!applied) {
          if (ev.subscription.status === "past_due" && prev?.status === "past_due" && prev.pastDueSince && Date.parse(prev.pastDueSince) > Date.parse(ev.occurredAt)) {
            await d.store.upsertSubscription({ ...prev, pastDueSince: ev.occurredAt });
          }
          return { status: "stale", reason: "out_of_order" };
        }
        return { status: "processed", reason: ev.subscription.userId ? null : "no_user_id" };
      }
      case "customer": {
        const { applied } = await d.store.upsertCustomer(ev.customer);
        return applied ? { status: "processed", reason: null } : { status: "stale", reason: "out_of_order" };
      }
      case "record-only":
        return { status: "processed", reason: null };
      case "ignored":
        return { status: "ignored", reason: "unknown_event" };
    }
  }
  return async function handle(req) {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    let rawBody;
    try {
      rawBody = await req.text();
    } catch {
      return reject("missing_body", 400);
    }
    if (!rawBody) return reject("missing_body", 400);
    const verified = await verifySignature({
      rawBody,
      header: req.headers.get("paddle-signature"),
      secret: d.secret,
      toleranceSeconds: d.toleranceSeconds,
      now: d.now().getTime()
    });
    if (!verified.ok) return reject(verified.reason, verified.reason === "bad_signature_header" ? 400 : 401);
    let parsed;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return reject("bad_json", 400);
    }
    const ev = parseEvent(parsed);
    if (!ev) return reject("bad_payload", 400);
    const tag = { eventId: ev.eventId, eventType: ev.eventType };
    let recorded = false;
    try {
      const { alreadyDone } = await d.store.recordEvent({ ...tag, occurredAt: ev.occurredAt, receivedAt: d.now().toISOString() });
      recorded = true;
      if (alreadyDone) return json({ received: true, duplicate: true }, 200);
      const outcome = await apply(ev);
      await d.store.markEvent(ev.eventId, outcome.status, outcome.reason);
      if (outcome.reason && outcome.reason !== "unknown_event") d.log({ level: "warn", reason: outcome.reason, ...tag });
      return json({ received: true }, 200);
    } catch {
      d.log({ level: "error", reason: "store_error", ...tag });
      try {
        if (!recorded) throw new Error("event row never written");
        await d.store.markEvent(ev.eventId, "failed", "store_error");
      } catch {
        try {
          await d.store.recordFailure("store_error", d.now());
        } catch {
        }
      }
      return json({ error: "store_error" }, 500);
    }
  };
}

// src/core/billing.ts
var defaultLog = (entry) => console[entry.level](JSON.stringify({ source: "paddle-kit", ...entry }));
function createBilling(config) {
  if (!config.webhookSecret) throw new Error("paddle-kit: webhookSecret is required");
  const nodeEnv = globalThis.process?.env?.NODE_ENV;
  if (config.environment === "production" && nodeEnv !== void 0 && nodeEnv !== "production" && !config.allowProductionInDev) {
    throw new Error('paddle-kit: environment "production" outside NODE_ENV=production; pass allowProductionInDev: true if intended');
  }
  const now = config.now ?? (() => /* @__PURE__ */ new Date());
  const log = config.log ?? defaultLog;
  const policy = { entitlements: config.entitlements, pastDueGraceDays: config.pastDueGraceDays ?? 7 };
  const handleWebhook = createWebhookHandler({
    store: config.store,
    secret: config.webhookSecret,
    toleranceSeconds: config.signatureToleranceSeconds ?? 5,
    log,
    now
  });
  const { webhookSecret: _omitted, ...publicConfig } = config;
  return {
    config: publicConfig,
    store: config.store,
    log,
    handleWebhook,
    async handleHealth(req) {
      if (!config.healthToken) return new Response(null, { status: 404 });
      if (req.headers.get("authorization") !== `Bearer ${config.healthToken}`) return new Response(null, { status: 401 });
      try {
        return Response.json(await config.store.health(now()));
      } catch {
        log({ level: "error", reason: "store_error" });
        return Response.json({ error: "store_error" }, { status: 503 });
      }
    },
    async hasAccess(userId, feature) {
      if (!userId) return false;
      return decideAccess(await config.store.getSubscriptionsByUser(userId), feature, policy, now());
    },
    getSubscriptions: (userId) => config.store.getSubscriptionsByUser(userId),
    health: () => config.store.health(now()),
    async recordFailure(reason) {
      log({ level: "warn", reason });
      try {
        await config.store.recordFailure(reason, now());
      } catch {
        log({ level: "error", reason: "store_error" });
      }
    }
  };
}
export {
  createBilling,
  decideAccess,
  verifySignature
};
