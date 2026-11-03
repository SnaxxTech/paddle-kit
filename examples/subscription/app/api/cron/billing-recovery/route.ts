// Hourly (vercel.json): replays what webhooks missed and repairs the mirror. Its budget is 45 s.
import { createRecoveryRoute } from 'paddle-kit/reconcile';
import { billing, config, problems } from '../../../../lib/billing';

export const maxDuration = 60;

export const { GET } = createRecoveryRoute({ billing, problems, apiKey: config?.apiKey, cronSecret: process.env.CRON_SECRET });
