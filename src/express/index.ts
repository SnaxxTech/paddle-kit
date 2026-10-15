import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import type { Billing } from '../core/billing';

/** Mount as: app.post('/paddle', express.raw({ type: '*\/*' }), paddleWebhook(billing)) */
export function paddleWebhook(billing: Billing) {
  return async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
    if (!Buffer.isBuffer(req.body)) {
      await billing.recordFailure('missing_raw_body');
      res.status(500).json({ error: 'missing_raw_body' });
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(', '));
    }
    const response = await billing.handleWebhook(
      new Request(`http://localhost${req.originalUrl}`, { method: req.method, headers, body: new Uint8Array(req.body) }),
    );
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.send(await response.text());
  };
}
