// src/core/events.ts
var EVENT_TYPES = {
  subscription: [
    "subscription.created",
    "subscription.imported",
    "subscription.updated",
    "subscription.activated",
    "subscription.trialing",
    "subscription.past_due",
    "subscription.paused",
    "subscription.resumed",
    "subscription.canceled"
  ],
  customer: ["customer.created", "customer.updated"],
  transaction: ["transaction.completed", "transaction.paid"],
  adjustment: ["adjustment.created", "adjustment.updated"]
};
var SUBSCRIPTION_EVENT_TYPES = new Set(EVENT_TYPES.subscription);
var CUSTOMER_EVENT_TYPES = new Set(EVENT_TYPES.customer);
var TRANSACTION_EVENT_TYPES = new Set(EVENT_TYPES.transaction);
var ADJUSTMENT_EVENT_TYPES = new Set(EVENT_TYPES.adjustment);
var STATUSES = /* @__PURE__ */ new Set(["active", "trialing", "past_due", "paused", "canceled"]);
var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var isStr = (v) => typeof v === "string" && v.length > 0;
var isTime = (v) => isStr(v) && !Number.isNaN(Date.parse(v));
var hasControlChars = (v) => /[\u0000-\u001f\u007f-\u009f]/.test(v);
var optUserId = (v) => isStr(v) && !hasControlChars(v) ? v : null;
var optStr = (v) => isStr(v) ? v : null;
function quantityOf(v) {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : 1;
}
function lineItemsOf(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const item of items) {
    if (!isObj(item)) continue;
    const price = isObj(item.price) ? item.price : null;
    const priceId = optStr(price?.id) ?? optStr(item.price_id);
    if (!priceId) continue;
    out.push({ priceId, productId: optStr(price?.product_id), quantity: quantityOf(item.quantity) });
  }
  return out;
}
var customDataFrom = (v) => isObj(v) ? v : null;
function itemsOf(sub) {
  return isObj(sub.raw) ? lineItemsOf(sub.raw.items) : [];
}
function customDataOf(sub) {
  return isObj(sub.raw) ? customDataFrom(sub.raw.custom_data) : null;
}
function subscriptionFrom(data, lastEventAt) {
  if (!isObj(data) || !isStr(data.id) || !isStr(data.customer_id) || !STATUSES.has(data.status) || !Array.isArray(data.items)) return null;
  const sc = isObj(data.scheduled_change) && isStr(data.scheduled_change.action) && isTime(data.scheduled_change.effective_at) ? { action: data.scheduled_change.action, effectiveAt: data.scheduled_change.effective_at } : null;
  return {
    subscriptionId: data.id,
    customerId: data.customer_id,
    userId: isObj(data.custom_data) ? optUserId(data.custom_data.userId) : null,
    status: data.status,
    priceIds: data.items.map((item) => item?.price?.id).filter(isStr),
    currentPeriodEnd: isObj(data.current_billing_period) ? optStr(data.current_billing_period.ends_at) : null,
    scheduledChange: sc,
    canceledAt: optStr(data.canceled_at),
    lastEventAt,
    raw: data
  };
}
function parseEvent(json) {
  if (!isObj(json) || !isStr(json.event_id) || !isStr(json.event_type) || !isTime(json.occurred_at) || !isObj(json.data)) {
    return null;
  }
  const env = { eventId: json.event_id, eventType: json.event_type, occurredAt: json.occurred_at };
  const data = json.data;
  if (SUBSCRIPTION_EVENT_TYPES.has(env.eventType)) {
    const subscription = subscriptionFrom(data, env.occurredAt);
    return subscription ? { ...env, kind: "subscription", subscription } : null;
  }
  if (CUSTOMER_EVENT_TYPES.has(env.eventType)) {
    if (!isStr(data.id)) return null;
    return { ...env, kind: "customer", customer: { customerId: data.id, email: optStr(data.email), lastEventAt: env.occurredAt } };
  }
  if (TRANSACTION_EVENT_TYPES.has(env.eventType)) {
    if (!isStr(data.id)) return null;
    const totals = isObj(data.details) && isObj(data.details.totals) ? data.details.totals : null;
    return {
      ...env,
      kind: "transaction",
      transaction: {
        transactionId: data.id,
        status: optStr(data.status) ?? "unknown",
        customerId: optStr(data.customer_id),
        subscriptionId: optStr(data.subscription_id),
        customData: customDataFrom(data.custom_data),
        items: lineItemsOf(data.items),
        currency: optStr(data.currency_code) ?? optStr(totals?.currency_code),
        total: optStr(totals?.grand_total) ?? optStr(totals?.total),
        subtotal: optStr(totals?.subtotal),
        occurredAt: env.occurredAt,
        raw: data
      }
    };
  }
  if (ADJUSTMENT_EVENT_TYPES.has(env.eventType)) {
    if (!isStr(data.id) || !isStr(data.transaction_id)) return null;
    return {
      ...env,
      kind: "adjustment",
      adjustment: {
        adjustmentId: data.id,
        action: optStr(data.action) ?? "unknown",
        type: data.type === "full" || data.type === "partial" ? data.type : null,
        status: optStr(data.status) ?? "unknown",
        transactionId: data.transaction_id,
        subscriptionId: optStr(data.subscription_id),
        customerId: optStr(data.customer_id),
        currency: optStr(data.currency_code) ?? (isObj(data.totals) ? optStr(data.totals.currency_code) : null),
        total: isObj(data.totals) ? optStr(data.totals.total) : null,
        subtotal: isObj(data.totals) ? optStr(data.totals.subtotal) : null,
        occurredAt: env.occurredAt,
        raw: data
      }
    };
  }
  return { ...env, kind: "ignored" };
}

export {
  EVENT_TYPES,
  itemsOf,
  customDataOf,
  subscriptionFrom,
  parseEvent
};
