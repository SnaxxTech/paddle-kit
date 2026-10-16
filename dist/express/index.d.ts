import { Request, Response } from 'express';
import { B as Billing } from '../billing-5Tle0Jiz.js';
import '../types-CqHfl8xh.js';

/** Mount as: app.post('/paddle', express.raw({ type: '*\/*' }), paddleWebhook(billing)) */
declare function paddleWebhook(billing: Billing): (req: Request, res: Response) => Promise<void>;
/** Mount as: app.get('/paddle/health', paddleHealth(billing)). Needs healthToken; 404 without it. */
declare function paddleHealth(billing: Billing): (req: Request, res: Response) => Promise<void>;

export { paddleHealth, paddleWebhook };
