// src/client/index.ts
import { initializePaddle } from "@paddle/paddle-js";
async function createCheckout(cfg) {
  const tokenEnv = cfg.token.startsWith("test_") ? "sandbox" : cfg.token.startsWith("live_") ? "production" : null;
  if (tokenEnv !== cfg.environment) {
    throw new Error(`paddle-kit: client token does not match environment "${cfg.environment}"`);
  }
  const paddle = await initializePaddle({ token: cfg.token, environment: cfg.environment });
  if (!paddle) throw new Error("paddle-kit: Paddle.js failed to initialise");
  return {
    open(o) {
      if (!o.userId) throw new Error("paddle-kit: userId is required so the subscription can be linked to the user");
      paddle.Checkout.open({
        items: [{ priceId: o.priceId, quantity: o.quantity ?? 1 }],
        customer: o.email ? { email: o.email } : void 0,
        customData: { userId: o.userId },
        settings: o.successUrl ? { successUrl: o.successUrl } : void 0
      });
    }
  };
}
export {
  createCheckout
};
