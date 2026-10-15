import { Context } from 'hono';
import { B as Billing } from '../billing-4EBe9L3i.js';
import '../types-BYpRwb7Q.js';

declare function paddleWebhook(billing: Billing): (c: Context) => Promise<Response>;
declare function paddleHealth(billing: Billing): (c: Context) => Promise<Response>;

export { paddleHealth, paddleWebhook };
