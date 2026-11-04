// Sends what the payments queued (receipts). Called twice: right after a payment commits (lib/billing.ts: bounded, so
// the webhook stays well inside Paddle's 5 s), and hourly by app/api/cron/outbox as the backstop for a failed send.
// No frequent cron: on Neon's free plan every query keeps the compute awake 5 more minutes (100 CU-hours a month).
import { drainOutbox, type DrainOptions } from 'paddle-kit/fulfil';
import { db } from './db';
import { sendReceipt } from './email';

export const sendOutbox = (o: DrainOptions) => drainOutbox(db.query, { receipt: sendReceipt }, o);
