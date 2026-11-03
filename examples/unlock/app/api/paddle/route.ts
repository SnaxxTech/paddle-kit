// POST: Paddle's webhooks. GET with `Authorization: Bearer $PADDLE_HEALTH_TOKEN`: the health report (paddle-kit-doctor).
import { createWebhookRoute } from 'paddle-kit/next';
import { billing, problems } from '../../../lib/billing';

export const { POST, GET } = createWebhookRoute({ billing, problems, healthToken: process.env.PADDLE_HEALTH_TOKEN });
