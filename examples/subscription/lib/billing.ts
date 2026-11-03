// The one billing config. Every value comes from the environment (README "Environment variables"); a missing or bad
// one turns billing off and lists its name in `problems` (never its value).
import { billingFromEnv } from 'paddle-kit/config';
import { postgresStore } from 'paddle-kit/postgres';
import { db } from './db';

export const { billing, config, problems, enforce, products } = billingFromEnv(process.env, {
  store: postgresStore({ query: db.query }),
  // PADDLE_PRICES keys, and what their prices grant. A replaced price moves to `retiredPriceIds`.
  products: { pro: { features: ['pro'], retiredPriceIds: [] } },
  // Health turns red before a customer notices: the API key's permissions, the migrations, CRON_SECRET.
  readiness: { cronSecret: process.env.CRON_SECRET },
  onError: (error, ctx) => console.error('paddle-kit failure', ctx, error), // may hold secrets: your error tracker only
});
if (problems.length > 0) console.error('billing misconfigured:', problems.join('; '));
