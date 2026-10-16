import { Billing } from '../core/index.js';
import '../types-BgyCdvFl.js';

/** App Router: `export const { POST, GET } = createNextRoute(billing);` in app/api/paddle/route.ts */
declare function createNextRoute(billing: Billing): {
    POST: (req: Request) => Promise<Response>;
    GET: (req: Request) => Promise<Response>;
};

export { createNextRoute };
