import { Billing } from '../core/index.js';
import '../types-BxRTIlXY.js';

/** App Router: `export const { POST, GET } = createNextRoute(billing);` in app/api/paddle/route.ts */
declare function createNextRoute(billing: Billing): {
    POST: (req: Request) => Promise<Response>;
    GET: (req: Request) => Promise<Response>;
};
interface WebhookRouteOptions {
    /** `null` when billing is off or misconfigured: build it only when `readBillingEnv` returned a config. */
    billing: Billing | null;
    /** `problems` from `readBillingEnv`. */
    problems: readonly string[];
    /**
     * `process.env.PADDLE_HEALTH_TOKEN`. Only used while `billing` is null: a GET with this bearer token then gets the
     * problem names (never values) in a 503, for `paddle-kit-doctor`. When billing is on, its own `healthToken` is used.
     */
    healthToken?: string;
}
/**
 * App Router, null-safe: `export const { POST, GET } = createWebhookRoute({ billing, problems, healthToken })`.
 * - billing on: POST = `handleWebhook`, GET = `handleHealth`.
 * - billing off (no billing variable set, `problems` empty): 404. GET says `{ error: "billing_off" }`.
 * - misconfigured (`problems` not empty): 503. GET with the health token also lists `problems`.
 */
declare function createWebhookRoute({ billing, problems, healthToken }: WebhookRouteOptions): {
    POST: (req: Request) => Promise<Response>;
    GET: (req: Request) => Promise<Response>;
};

export { createNextRoute, createWebhookRoute };
export type { WebhookRouteOptions };
