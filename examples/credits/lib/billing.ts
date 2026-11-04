// The one billing config. Every value comes from the environment (README "Environment variables"); a missing or bad
// one turns billing off and lists its name in `problems` (never its value).
import { billingFromEnv } from 'paddle-kit/config';
import { createFulfilment, outboxCheck, reviewsCheck } from 'paddle-kit/fulfil';
import { postgresStore } from 'paddle-kit/postgres';
import { db } from './db';
import { creditActions } from './fulfilment';
import { sendOutbox } from './outbox';

const fulfilment = createFulfilment(db, creditActions((priceId) => products?.productOf(priceId)?.key ?? null));

export const { billing, config, problems, enforce, products } = billingFromEnv(process.env, {
  store: postgresStore({ query: db.query }),
  // PADDLE_PRICES keys, and what their prices grant. A replaced price moves to `retiredPriceIds`.
  products: { pack: { features: [] } },
  // One-time payments: the kit keeps each payment's state and decides; lib/fulfilment.ts says what one grants.
  onTransaction: async (tx, ctx) => {
    await fulfilment.onTransaction!(tx, ctx);
    // The receipt the payment queued goes out now, with no cron waiting. Bounded to about 2 s (no claim after 1 s,
    // each send cut off at 1 s), well inside Paddle's 5 s; a failed or late send stays queued for the
    // hourly outbox route. The catch keeps a database error here from failing the payment, which is already applied.
    await sendOutbox({ limit: 3, budgetMs: 1_000, handlerTimeoutMs: 1_000 }).catch((error) => console.error('paddle-kit outbox send failed', (error as Error)?.name ?? 'Error'));
  },
  onAdjustment: (adj, ctx) => fulfilment.onAdjustment!(adj, ctx),
  healthChecks: { outbox: outboxCheck(db.query), reviews: reviewsCheck(db.query) },
  // Health turns red before a customer notices: the API key's permissions, the migrations, CRON_SECRET, and
  // outbox items or fulfilment reviews that wait for a person.
  readiness: { cronSecret: process.env.CRON_SECRET, fulfilment: true },
  // The error may hold a secret (a connection string, a provider key): the log gets its name; send the whole error
  // to your error tracker here if you have one.
  onError: (error, ctx) => console.error('paddle-kit failure', ctx, (error as Error)?.name ?? 'Error'),
});
if (problems.length > 0) console.error('billing misconfigured:', problems.join('; '));
