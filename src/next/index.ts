import type { Billing } from '../core/billing';
import { safeEqual } from '../core/signature';

/** App Router: `export const { POST, GET } = createNextRoute(billing);` in app/api/paddle/route.ts */
export function createNextRoute(billing: Billing) {
  return {
    POST: (req: Request) => billing.handleWebhook(req),
    GET: (req: Request) => billing.handleHealth(req),
  };
}

export interface WebhookRouteOptions {
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

const json = (status: number, body: unknown) => Response.json(body, { status });

/**
 * App Router, null-safe: `export const { POST, GET } = createWebhookRoute({ billing, problems, healthToken })`.
 * - billing on: POST = `handleWebhook`, GET = `handleHealth`.
 * - billing off (no billing variable set, `problems` empty): 404. GET says `{ error: "billing_off" }`.
 * - misconfigured (`problems` not empty): 503. GET with the health token also lists `problems`.
 */
export function createWebhookRoute({ billing, problems, healthToken }: WebhookRouteOptions) {
  if (billing) {
    return {
      POST: (req: Request) => billing.handleWebhook(req),
      GET: (req: Request) => (billing.config.healthToken ? billing.handleHealth(req) : Promise.resolve(json(404, { error: 'health_off' }))),
    };
  }
  const misconfigured = problems.length > 0;
  return {
    POST: async (_req: Request) => new Response(null, { status: misconfigured ? 503 : 404 }),
    GET: async (req: Request) => {
      if (!misconfigured) return json(404, { error: 'billing_off' });
      const authorized = !!healthToken && (await safeEqual(req.headers.get('authorization') ?? '', `Bearer ${healthToken}`));
      return authorized ? json(503, { error: 'misconfigured', problems }) : new Response(null, { status: 503 });
    },
  };
}
