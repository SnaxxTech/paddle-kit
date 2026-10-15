import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import type { Billing } from '../core/billing';

function toHeaders(req: ExpressRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(', '));
  }
  return headers;
}

async function forward(response: Response, res: ExpressResponse): Promise<void> {
  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.send(await response.text());
}

function fail(billing: Billing, res: ExpressResponse): void {
  // Express 4 does not catch async rejections, so answer here instead of hanging the request.
  try {
    billing.log({ level: 'error', reason: 'store_error' });
  } catch {
    /* logging must never mask the 500 */
  }
  if (!res.headersSent) res.status(500).json({ error: 'store_error' });
}

/** Mount as: app.post('/paddle', express.raw({ type: '*\/*' }), paddleWebhook(billing)) */
export function paddleWebhook(billing: Billing) {
  return async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
    try {
      if (!Buffer.isBuffer(req.body)) {
        await billing.recordFailure('missing_raw_body');
        res.status(500).json({ error: 'missing_raw_body' });
        return;
      }
      const response = await billing.handleWebhook(
        new Request(`http://localhost${req.originalUrl}`, { method: req.method, headers: toHeaders(req), body: new Uint8Array(req.body) }),
      );
      await forward(response, res);
    } catch {
      fail(billing, res);
    }
  };
}

/** Mount as: app.get('/paddle/health', paddleHealth(billing)). Needs healthToken; 404 without it. */
export function paddleHealth(billing: Billing) {
  return async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
    try {
      const response = await billing.handleHealth(
        new Request(`http://localhost${req.originalUrl}`, { method: req.method, headers: toHeaders(req) }),
      );
      await forward(response, res);
    } catch {
      fail(billing, res);
    }
  };
}
