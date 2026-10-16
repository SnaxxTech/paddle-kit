import { B as Billing } from '../billing-5Tle0Jiz.js';
import '../types-CqHfl8xh.js';

/** App Router: `export const { POST, GET } = createNextRoute(billing);` in app/api/paddle/route.ts */
declare function createNextRoute(billing: Billing): {
    POST: (req: Request) => Promise<Response>;
    GET: (req: Request) => Promise<Response>;
};

export { createNextRoute };
