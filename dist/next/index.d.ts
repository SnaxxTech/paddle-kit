import { B as Billing } from '../billing-DX2R5S3A.js';
import '../types-BxRTIlXY.js';

/** App Router: `export const { POST, GET } = createNextRoute(billing);` in app/api/paddle/route.ts */
declare function createNextRoute(billing: Billing): {
    POST: (req: Request) => Promise<Response>;
    GET: (req: Request) => Promise<Response>;
};

export { createNextRoute };
