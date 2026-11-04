import {
  LIVE_BASE,
  PaddleError,
  SANDBOX_BASE,
  paddleClient
} from "../chunk-EHTDG5JE.js";

// src/server/index.ts
function client(api) {
  const keyEnv = api.apiKey.startsWith("pdl_live_") ? "production" : api.apiKey.startsWith("pdl_sdbx_") ? "sandbox" : null;
  if (keyEnv !== api.environment) throw new PaddleError(`the API key is not a ${api.environment} key`);
  const fetchImpl = api.fetch ?? ((url, init) => fetch(url, init));
  return paddleClient(api.environment === "production" ? LIVE_BASE : SANDBOX_BASE, api.apiKey, fetchImpl, [api.apiKey]);
}
async function createCheckoutTransaction(api, o) {
  if (!o.userId) throw new PaddleError("userId is required so the purchase can be linked to the user");
  if (!Array.isArray(o.items) || o.items.length === 0) throw new PaddleError("a checkout needs at least one item");
  for (const i of o.items) {
    if (!Number.isInteger(i.quantity) || i.quantity < 1) throw new PaddleError(`quantity for ${i.priceId} must be a whole number of at least 1`);
    if (o.allowedPriceIds && !o.allowedPriceIds.includes(i.priceId)) throw new PaddleError(`price ${i.priceId} is not for sale`);
  }
  const res = await client(api).call("POST", "/transactions", {
    items: o.items.map((i) => ({ price_id: i.priceId, quantity: i.quantity })),
    ...o.customerId ? { customer_id: o.customerId } : {},
    collection_mode: "automatic",
    custom_data: { ...o.customData, userId: o.userId }
  });
  const id = res.data?.id;
  if (typeof id !== "string" || !id.startsWith("txn_")) throw new PaddleError("Paddle answered with no transaction id");
  const url = res.data?.checkout?.url;
  return { transactionId: id, checkoutUrl: typeof url === "string" ? url : null };
}
var PORTAL = /^https:\/\/(sandbox-)?customer-portal\.paddle\.com\//;
function portalUrl(u) {
  if (typeof u !== "string" || !PORTAL.test(u)) throw new PaddleError("Paddle answered with a link that is not a Paddle customer portal link");
  return u;
}
async function customerPortalSession(api, o) {
  if (!/^ctm_[a-z\d]+$/.test(o.customerId)) throw new PaddleError("customerId must be a Paddle customer id (ctm_\u2026)");
  const res = await client(api).call("POST", `/customers/${o.customerId}/portal-sessions`, { subscription_ids: [...o.subscriptionIds ?? []] });
  const urls = res.data?.urls;
  const subscriptions = {};
  for (const s of Array.isArray(urls?.subscriptions) ? urls.subscriptions : []) {
    subscriptions[String(s.id)] = { cancel: portalUrl(s.cancel_subscription), updatePaymentMethod: portalUrl(s.update_subscription_payment_method) };
  }
  return { overview: portalUrl(urls?.general?.overview), subscriptions };
}
export {
  PaddleError,
  createCheckoutTransaction,
  customerPortalSession
};
