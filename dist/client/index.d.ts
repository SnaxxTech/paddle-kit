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
}>;

export { type CheckoutItem, type CheckoutOptions, createCheckout };
