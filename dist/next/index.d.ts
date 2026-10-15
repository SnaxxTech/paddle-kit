import { B as Billing } from '../billing-4EBe9L3i.js';
import '../types-BYpRwb7Q.js';

/** App Router: `export const { POST, GET } = createNextRoute(billing);` in app/api/paddle/route.ts */
declare function createNextRoute(billing: Billing): {
    POST: (req: Request) => Promise<Response>;
    GET: (req: Request) => Promise<Response>;
};

export { createNextRoute };
