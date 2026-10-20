import {
  decideAccess,
  nextPastDueSince,
  ownershipPredicate
} from "../chunk-C4ZLQRN7.js";
import {
  customDataOf,
  itemsOf,
  parseEvent
} from "../chunk-UYGU5JF5.js";

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
var HookFailure = class extends Error {
};
var QUIET = /* @__PURE__ */ new Set(["unknown_event", "not_ours", "unmatched", "mirrored"]);
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
  async function runHook(hook) {
    if (!hook) return;
    try {
      await hook();
    } catch {
      throw new HookFailure("hook threw");
    }
  }
  const NOT_OURS = { status: "ignored", reason: "not_ours" };
  function matches(x) {
    if (!d.owns) return true;
    try {
      return d.owns(x) === true;
    } catch {
      throw new HookFailure("owns threw");
    }
  }
  async function apply(ev) {
    switch (ev.kind) {
      case "subscription": {
        const prev = await d.store.getSubscription(ev.subscription.subscriptionId);
        const ours = matches({ kind: "subscription", items: itemsOf(ev.subscription), customData: customDataOf(ev.subscription) });
        if (!prev && !ours) return NOT_OURS;
        const pastDueSince = nextPastDueSince(prev, ev.subscription.status, ev.occurredAt);
        const { applied } = await d.store.upsertSubscription({ ...ev.subscription, pastDueSince });
        if (!applied) {
          if (ev.subscription.status === "past_due" && prev?.status === "past_due" && prev.pastDueSince && Date.parse(prev.pastDueSince) > Date.parse(ev.occurredAt)) {
            await d.store.upsertSubscription({ ...prev, pastDueSince: ev.occurredAt });
          }
          return { status: "stale", reason: "out_of_order" };
        }
        if (!ours) return { status: "processed", reason: "mirrored" };
        return { status: "processed", reason: ev.subscription.userId ? null : "no_user_id" };
      }
      case "transaction": {
        const tx = ev.transaction;
        const ours = matches({ kind: "transaction", items: tx.items, customData: tx.customData });
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
        const ours = sub ? matches({ kind: "subscription", items: itemsOf(sub), customData: customDataOf(sub) }) : seen?.owned === true;
        await runHook(d.onAdjustment && (() => d.onAdjustment(ev.adjustment, ctx)));
        return { status: "processed", reason: !ctx.known ? "unmatched" : ours ? null : "mirrored" };
      }
      case "ignored":
        return { status: "ignored", reason: "unknown_event" };
    }
  }
  return async function handle(req) {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    let rawBody;
    try {
      rawBody = await readBody(req, d.maxBodyBytes ?? MAX_WEBHOOK_BODY_BYTES);
    } catch {
      return reject("missing_body", 400);
    }
    if (rawBody === null) return reject("body_too_large", 413);
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
      const at = d.now();
      const leaseExpiredBefore = new Date(at.getTime() - (d.leaseSeconds ?? 60) * 1e3).toISOString();
      const claim = await d.store.recordEvent({ ...tag, occurredAt: ev.occurredAt, receivedAt: at.toISOString(), leaseExpiredBefore });
      if (claim.alreadyDone) return json({ received: true, duplicate: true }, 200);
      if (claim.inProgress) return json({ error: "in_progress" }, 409);
      recorded = true;
      const outcome = await apply(ev);
      await d.store.markEvent(ev.eventId, outcome.status, outcome.reason);
      if (outcome.reason && !QUIET.has(outcome.reason)) d.log({ level: "warn", reason: outcome.reason, ...tag });
      return json({ received: true }, 200);
    } catch (err) {
      const reason = err instanceof HookFailure ? "hook_error" : "store_error";
      d.log({ level: "error", reason, ...tag });
      try {
        if (!recorded) throw new Error("event row never written");
        await d.store.markEvent(ev.eventId, "failed", reason);
      } catch {
        if (reason === "hook_error") d.log({ level: "error", reason: "store_error", ...tag });
        try {
          await d.store.recordFailure(reason === "hook_error" ? "hook_error" : "store_error", d.now());
        } catch {
        }
      }
      return json({ error: reason }, 500);
    }
  };
}

// package.json
var version = "0.5.0";

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
  const owns = ownershipPredicate(config.owns);
  const handleWebhook = createWebhookHandler({
    owns,
    store: config.store,
    secret: config.webhookSecret,
    toleranceSeconds: 5,
    leaseSeconds: config.eventLeaseSeconds,
    log,
    now,
    onTransaction: config.onTransaction,
    onAdjustment: config.onAdjustment,
    maxBodyBytes: config.maxBodyBytes
  });
  const { webhookSecret: _omitted, ...publicConfig } = config;
  return {
    config: publicConfig,
    store: config.store,
    handleWebhook,
    async handleHealth(req) {
      if (!config.healthToken) return new Response(null, { status: 404 });
      if (!constantTimeEqual(req.headers.get("authorization") ?? "", `Bearer ${config.healthToken}`)) return new Response(null, { status: 401 });
      try {
        return Response.json({ ...await config.store.health(now()), kitVersion: version, environment: config.environment });
      } catch {
        log({ level: "error", reason: "store_error" });
        return Response.json({ error: "store_error" }, { status: 503 });
      }
    },
    async hasAccess(userId, feature) {
      if (!userId) return false;
      return decideAccess(await config.store.getSubscriptionsByUser(userId), feature, policy, now());
    }
  };
}
export {
  MAX_WEBHOOK_BODY_BYTES,
  createBilling
};
