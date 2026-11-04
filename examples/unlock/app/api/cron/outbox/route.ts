// Hourly (vercel.json, with recovery: one database wake-up), the backstop for a receipt whose send right after the
// payment failed. Bounded: at most 50 items, no new claim after 20 s, inside the route's 30 s.
import { createOutboxRoute } from 'paddle-kit/fulfil';
import { sendOutbox } from '../../../../lib/outbox';

export const maxDuration = 30;

export const { GET } = createOutboxRoute({ cronSecret: process.env.CRON_SECRET, drain: () => sendOutbox({ limit: 50, budgetMs: 20_000 }) });
