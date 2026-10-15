import type { Context } from 'hono';
import type { Billing } from '../core/billing';

export function paddleWebhook(billing: Billing) {
  return (c: Context) => billing.handleWebhook(c.req.raw);
}

export function paddleHealth(billing: Billing) {
  return (c: Context) => billing.handleHealth(c.req.raw);
}
