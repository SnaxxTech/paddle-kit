import { Context } from 'hono';
import { B as Billing } from '../billing-5Tle0Jiz.js';
import '../types-CqHfl8xh.js';

declare function paddleWebhook(billing: Billing): (c: Context) => Promise<Response>;
declare function paddleHealth(billing: Billing): (c: Context) => Promise<Response>;

export { paddleHealth, paddleWebhook };
