import type { Billing } from '../core/billing';

/** App Router: `export const { POST, GET } = createNextRoute(billing);` in app/api/paddle/route.ts */
export function createNextRoute(billing: Billing) {
  return {
    POST: (req: Request) => billing.handleWebhook(req),
    GET: (req: Request) => billing.handleHealth(req),
  };
}
