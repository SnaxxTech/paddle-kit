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

export { FetchLike, createCheckoutTransaction, customerPortalSession };
export type { CheckoutTransactionOptions, PaddleApi };
