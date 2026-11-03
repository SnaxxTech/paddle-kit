type CheckoutItem = {
    priceId: string;
    quantity: number;
};
type CheckoutOptions = {
    items: CheckoutItem[];
    userId: string;
    email?: string;
    /** Extra custom data (e.g. an order id) sent with the checkout. `userId` is always set from `userId` and cannot be overridden. */
    customData?: Record<string, unknown>;
};
declare function createCheckout(cfg: {
    token: string;
    environment: 'sandbox' | 'production';
    onEvent?: (event: unknown) => void;
}): Promise<{
    open(o: CheckoutOptions): void;
    /**
     * Since v0.8.4: opens the checkout for a transaction the server created (`createCheckoutTransaction` in
     * paddle-kit/server). Paddle takes the items, customer and custom data from that transaction. Since v0.8.5:
     * `email` prefills the email field when the transaction has no customer yet (a first purchase); Paddle ignores it
     * for a transaction created with `customerId`.
     */
    openTransaction(transactionId: string, o?: {
        email?: string;
    }): void;
}>;

export { createCheckout };
export type { CheckoutItem, CheckoutOptions };
