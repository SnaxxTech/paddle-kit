import {
  constantTimeEqual
} from "../chunk-STOKI6WW.js";

// src/next/index.ts
function createNextRoute(billing) {
  return {
    POST: (req) => billing.handleWebhook(req),
    GET: (req) => billing.handleHealth(req)
  };
}
var json = (status, body) => Response.json(body, { status });
function createWebhookRoute({ billing, problems, healthToken }) {
  if (billing) {
    return {
      POST: (req) => billing.handleWebhook(req),
      GET: (req) => billing.config.healthToken ? billing.handleHealth(req) : Promise.resolve(json(404, { error: "health_off" }))
    };
  }
  const misconfigured = problems.length > 0;
  return {
    POST: async (_req) => new Response(null, { status: misconfigured ? 503 : 404 }),
    GET: async (req) => {
      if (!misconfigured) return json(404, { error: "billing_off" });
      const authorized = !!healthToken && constantTimeEqual(req.headers.get("authorization") ?? "", `Bearer ${healthToken}`);
      return authorized ? json(503, { error: "misconfigured", problems }) : new Response(null, { status: 503 });
    }
  };
}
export {
  createNextRoute,
  createWebhookRoute
};
