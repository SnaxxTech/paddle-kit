import { F as FetchLike } from '../paddle-api-CrEnAa2Z.js';
export { P as PaddleError } from '../paddle-api-CrEnAa2Z.js';

interface PaddleApi {
    /** PADDLE_API_KEY (`pdl_sdbx_…` for sandbox, `pdl_live_…` for production). */
    apiKey: string;
    environment: 'sandbox' | 'production';
    /** Default: global fetch. Pass `transport.fetch` (from `billingFromEnv`) for retries of GETs and a circuit breaker. */
    fetch?: FetchLike;
}
interface CheckoutTransactionOptions {
    /** From your server session, never from the request: it is written to `custom_data.userId`. */
    userId: string;
    items: {
        priceId: string;
        quantity: number;
    }[];
    /** The user's Paddle customer (`ctm_…`), when known: checkout opens for them. */
    customerId?: string;
    /** Extra custom data. `userId` always comes from `userId` and cannot be overridden. */
    customData?: Record<string, unknown>;
    /** Prices the server allows selling (e.g. the products' prices on sale); anything else is refused. */
    allowedPriceIds?: readonly string[];
}
/**
 * Creates an automatically-collected transaction on the server and returns its id. Open it in the browser with
 * `checkout.openTransaction(transactionId)` (paddle-kit/client): the user, the items and the prices are decided here,
 * so the browser cannot change who is paid for or what is bought. `checkoutUrl` is Paddle's payment link for it (your
 * default payment link + `_ptxn`), or null.
 */
declare function createCheckoutTransaction(api: PaddleApi, o: CheckoutTransactionOptions): Promise<{
    transactionId: string;
    checkoutUrl: string | null;
}>;
/**
 * A fresh customer portal session (create one per click: the links are personal and expire). Only links on Paddle's
 * own portal host (`customer-portal.paddle.com`, or `sandbox-customer-portal.paddle.com`) are returned; anything else
 * throws, so the app never redirects a user elsewhere. Look the customer up from your own records, never the request.
 */
declare function customerPortalSession(api: PaddleApi, o: {
    customerId: string;
    subscriptionIds?: readonly string[];
}): Promise<{
    overview: string;
    subscriptions: Record<string, {
        cancel: string;
        updatePaymentMethod: string;
    }>;
}>;
/**
 * Cancels a subscription (since v0.9.2), immediately by default: Paddle sets it `canceled` and the
 * `subscription.canceled` webhook ends access. Paddle never cancels a subscription because a payment was refunded or
 * charged back; the subscription starter calls this from `onAdjustment` for an approved full refund or a chargeback.
 * A canceled subscription cannot be reinstated (a won dispute does not bring it back). Needs `subscription.write`.
 * Idempotent: when Paddle refuses because the subscription is already canceled (a replay, or a second refund or
 * chargeback before the canceled webhook arrives), it answers `{ status: 'canceled' }` instead of throwing.
 */
declare function cancelSubscription(api: PaddleApi, subscriptionId: string, o?: {
    effectiveFrom?: 'immediately' | 'next_billing_period';
}): Promise<{
    status: string;
}>;

export { FetchLike, cancelSubscription, createCheckoutTransaction, customerPortalSession };
export type { CheckoutTransactionOptions, PaddleApi };
