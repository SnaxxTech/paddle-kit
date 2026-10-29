import {
  LIVE_BASE,
  SANDBOX_BASE,
  paddleClient
} from "../chunk-EMR6PZ3J.js";
import {
  nextPastDueSince,
  ownershipPredicate
} from "../chunk-C4ZLQRN7.js";
import {
  customDataOf,
  itemsOf,
  subscriptionFrom
} from "../chunk-UYGU5JF5.js";

// src/reconcile/index.ts
async function reconcile(billing, opts) {
  const keyEnv = opts.apiKey.startsWith("pdl_sdbx_") ? "sandbox" : opts.apiKey.startsWith("pdl_live_") ? "production" : null;
  if (keyEnv !== billing.config.environment) {
    throw new Error(`paddle-kit: API key does not match environment "${billing.config.environment}"`);
  }
  const base = billing.config.environment === "production" ? LIVE_BASE : SANDBOX_BASE;
  const api = paddleClient(base, opts.apiKey, opts.fetch ?? ((url, init) => fetch(url, init)), [opts.apiKey]);
  const owns = ownershipPredicate(billing.config.owns);
  let scanned = 0;
  let applied = 0;
  let notOurs = 0;
  let invalid = 0;
  for (const data of await api.list("/subscriptions?per_page=200", 1e3)) {
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
    const result = await billing.store.upsertSubscription({ ...sub, pastDueSince: nextPastDueSince(prev, sub.status, sub.lastEventAt) });
    if (result.applied) applied++;
  }
  return { scanned, applied, notOurs, invalid };
}
export {
  reconcile
};
