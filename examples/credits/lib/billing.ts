// The one billing config. Every value comes from the environment (README "Environment variables"); a missing or bad
// one turns billing off and lists its name in `problems` (never its value).
import { billingFromEnv } from 'paddle-kit/config';
import { createFulfilment, outboxCheck, reviewsCheck } from 'paddle-kit/fulfil';
import { postgresStore } from 'paddle-kit/postgres';
import { db } from './db';
import { creditActions } from './fulfilment';

export const { billing, config, problems, enforce, products } = billingFromEnv(process.env, {
  store: postgresStore({ query: db.query }),
  // PADDLE_PRICES keys, and what their prices grant. A replaced price moves to `retiredPriceIds`.
  products: { pack: { features: [] } },
  // One-time payments: the kit keeps each payment's state and decides; lib/fulfilment.ts says what one grants.
  ...createFulfilment(db, creditActions((priceId) => products?.productOf(priceId)?.key ?? null)),
  healthChecks: { outbox: outboxCheck(db.query), reviews: reviewsCheck(db.query) },
  // Health turns red before a customer notices: the API key's permissions, the migrations, CRON_SECRET, and
  // outbox items or fulfilment reviews that wait for a person.
  readiness: { cronSecret: process.env.CRON_SECRET, fulfilment: true },
  onError: (error, ctx) => console.error('paddle-kit failure', ctx, error), // may hold secrets: your error tracker only
});
if (problems.length > 0) console.error('billing misconfigured:', problems.join('; '));
