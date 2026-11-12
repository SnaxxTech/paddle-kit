import { initializePaddle } from '@paddle/paddle-js';

export type CheckoutItem = { priceId: string; quantity: number };
export type CheckoutOptions = {
  items: CheckoutItem[];
  userId: string;
  email?: string;
  /** Extra custom data (e.g. an order id) sent with the checkout. In this call `userId` is always set from `userId`; a buyer can still change custom data in the browser, so the server treats it as untrusted. */
  customData?: Record<string, unknown>;
};

export async function createCheckout(cfg: {
  token: string;
  environment: 'sandbox' | 'production';
  onEvent?: (event: unknown) => void;
}) {
  const tokenEnv = cfg.token.startsWith('test_') ? 'sandbox' : cfg.token.startsWith('live_') ? 'production' : null;
  if (tokenEnv !== cfg.environment) {
    throw new Error(`paddle-kit: client token does not match environment "${cfg.environment}"`);
  }
  const paddle = await initializePaddle(
    cfg.onEvent
      ? { token: cfg.token, environment: cfg.environment, eventCallback: (e: unknown) => cfg.onEvent!(e) }
      : { token: cfg.token, environment: cfg.environment },
  );
  if (!paddle) throw new Error('paddle-kit: Paddle.js failed to initialise');
  return {
    open(o: CheckoutOptions): void {
      if (!o.userId) throw new Error('paddle-kit: userId is required so the subscription can be linked to the user');
      if (!Array.isArray(o.items) || o.items.length === 0) throw new Error('paddle-kit: items needs at least one { priceId, quantity }');
      paddle.Checkout.open({
        items: o.items,
        customer: o.email ? { email: o.email } : undefined,
        customData: { ...o.customData, userId: o.userId },
      });
    },
    /**
     * Since v0.8.4: opens the checkout for a transaction the server created (`createCheckoutTransaction` in
     * paddle-kit/server). Paddle starts from that transaction's items, customer and custom data; the buyer can still
     * change items and custom data in the browser, so the webhook hook decides what is granted. Since v0.8.5:
     * `email` prefills the email field when the transaction has no customer yet (a first purchase); Paddle ignores it
     * for a transaction created with `customerId`.
     */
    openTransaction(transactionId: string, o: { email?: string } = {}): void {
      if (!/^txn_[a-z\d]+$/.test(transactionId)) throw new Error('paddle-kit: openTransaction needs a transaction id (txn_…)');
      paddle.Checkout.open(o.email ? { transactionId, customer: { email: o.email } } : { transactionId });
    },
  };
}
