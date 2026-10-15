// src/next/index.ts
function createNextRoute(billing) {
  return {
    POST: (req) => billing.handleWebhook(req),
    GET: (req) => billing.handleHealth(req)
  };
}
export {
  createNextRoute
};
