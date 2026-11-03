// Every 5 minutes (vercel.json), apart from recovery: sends the receipts queued with each payment. Bounded: at most
// 50 items, no new claim after 20 s, inside the route's 30 s.
import { createOutboxRoute, drainOutbox } from 'paddle-kit/fulfil';
import { db } from '../../../../lib/db';
import { sendReceipt } from '../../../../lib/email';

export const maxDuration = 30;

export const { GET } = createOutboxRoute({
  cronSecret: process.env.CRON_SECRET,
  drain: () => drainOutbox(db.query, { receipt: sendReceipt }, { limit: 50, budgetMs: 20_000 }),
});
