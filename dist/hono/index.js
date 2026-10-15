// src/hono/index.ts
function paddleWebhook(billing) {
  return (c) => billing.handleWebhook(c.req.raw);
}
function paddleHealth(billing) {
  return (c) => billing.handleHealth(c.req.raw);
}
export {
  paddleHealth,
  paddleWebhook
};
