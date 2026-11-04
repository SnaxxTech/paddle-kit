// The one billing config. Every value comes from the environment (README "Environment variables"); a missing or bad
// one turns billing off and lists its name in `problems` (never its value).
import { billingFromEnv } from 'paddle-kit/config';
import { adjustmentEffect } from 'paddle-kit/core';
import { cancelSubscription } from 'paddle-kit/server';
import { postgresStore } from 'paddle-kit/postgres';
import { db } from './db';

export const { billing, config, problems, enforce, products, transport } = billingFromEnv(process.env, {
  store: postgresStore({ query: db.query }),
  // PADDLE_PRICES keys, and what their prices grant. A replaced price moves to `retiredPriceIds`.
  products: { pro: { features: ['pro'], retiredPriceIds: [] } },
  // A full refund or a chargeback ends the subscription at once: Paddle never cancels it by itself. A failed cancel
  // throws, so the webhook fails and Paddle sends it again; an already canceled one is left alone.
  // Only this app's own subscription: on a shared seller account every app receives every app's adjustments, and the
  // shared API key could cancel a sibling app's customer. Ours = known to the kit and in this app's mirror.
  onAdjustment: async (adj, ctx) => {
    if (!adj.subscriptionId || adjustmentEffect(adj) !== 'revoke' || !ctx.known) return;
    const sub = await ctx.store.getSubscription(adj.subscriptionId);
    if (!sub || sub.status === 'canceled') return;
    if (!config?.apiKey) throw new Error('PADDLE_API_KEY is needed to cancel a refunded subscription');
    await cancelSubscription({ apiKey: config.apiKey, environment: config.environment, fetch: transport?.fetch }, adj.subscriptionId);
  },
  // Health turns red before a customer notices: the API key's permissions (subscription.write for the cancel above),
  // the migrations, CRON_SECRET.
  readiness: { cronSecret: process.env.CRON_SECRET, permissions: ['subscription.write'] },
  // The error may hold a secret (a connection string, a provider key): the log gets its name; send the whole error
  // to your error tracker here if you have one.
  onError: (error, ctx) => console.error('paddle-kit failure', ctx, (error as Error)?.name ?? 'Error'),
});
if (problems.length > 0) console.error('billing misconfigured:', problems.join('; '));
