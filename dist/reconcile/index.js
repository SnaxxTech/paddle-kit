import {
  nextPastDueSince
} from "../chunk-47QH2E5T.js";

// src/reconcile/index.ts
import { Environment, Paddle } from "@paddle/paddle-node-sdk";
function fromSdkSubscription(s) {
  const userId = s.customData?.userId;
  return {
    subscriptionId: s.id,
    customerId: s.customerId,
    userId: typeof userId === "string" && userId ? userId : null,
    status: s.status,
    priceIds: s.items.map((i) => i.price?.id).filter((id) => !!id),
    currentPeriodEnd: s.currentBillingPeriod?.endsAt ?? null,
    scheduledChange: s.scheduledChange ? { action: s.scheduledChange.action, effectiveAt: s.scheduledChange.effectiveAt } : null,
    canceledAt: s.canceledAt ?? null,
    // updatedAt, not "now": a webhook that occurred after this snapshot must still win.
    lastEventAt: s.updatedAt,
    raw: s
  };
}
async function reconcile(billing, opts) {
  const keyEnv = opts.apiKey.startsWith("pdl_sdbx_") ? "sandbox" : opts.apiKey.startsWith("pdl_live_") ? "production" : null;
  if (keyEnv !== billing.config.environment) {
    throw new Error(`paddle-kit: API key does not match environment "${billing.config.environment}"`);
  }
  const client = opts.client ?? new Paddle(opts.apiKey, {
    environment: billing.config.environment === "production" ? Environment.production : Environment.sandbox
  });
  let scanned = 0;
  let applied = 0;
  for await (const raw of client.subscriptions.list()) {
    scanned++;
    const sub = fromSdkSubscription(raw);
    const prev = await billing.store.getSubscription(sub.subscriptionId);
    const result = await billing.store.upsertSubscription({ ...sub, pastDueSince: nextPastDueSince(prev, sub.status, sub.lastEventAt) });
    if (result.applied) applied++;
  }
  return { scanned, applied };
}
export {
  fromSdkSubscription,
  reconcile
};
