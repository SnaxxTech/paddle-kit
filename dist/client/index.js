// src/client/index.ts
import { initializePaddle } from "@paddle/paddle-js";
async function createCheckout(cfg) {
  const tokenEnv = cfg.token.startsWith("test_") ? "sandbox" : cfg.token.startsWith("live_") ? "production" : null;
  if (tokenEnv !== cfg.environment) {
    throw new Error(`paddle-kit: client token does not match environment "${cfg.environment}"`);
  }
  const paddle = await initializePaddle(
    cfg.onEvent ? { token: cfg.token, environment: cfg.environment, eventCallback: (e) => cfg.onEvent(e) } : { token: cfg.token, environment: cfg.environment }
  );
  if (!paddle) throw new Error("paddle-kit: Paddle.js failed to initialise");
  return {
    open(o) {
      if (!o.userId) throw new Error("paddle-kit: userId is required so the subscription can be linked to the user");
      if (!Array.isArray(o.items) || o.items.length === 0) throw new Error("paddle-kit: items needs at least one { priceId, quantity }");
      paddle.Checkout.open({
        items: o.items,
        customer: o.email ? { email: o.email } : void 0,
        customData: { ...o.customData, userId: o.userId }
      });
    }
  };
}
export {
  createCheckout
};
