type CheckoutItem = {
    priceId: string;
    quantity: number;
};
type CheckoutOptions = {
    userId: string;
    email?: string;
    successUrl?: string;
    /** Extra custom data (e.g. an order id) sent with the checkout. `userId` is always set from `userId` and cannot be overridden. */
    customData?: Record<string, unknown>;
} & ({
    priceId: string;
    quantity?: number;
    items?: never;
} | {
    items: CheckoutItem[];
    priceId?: never;
    quantity?: never;
});
declare function createCheckout(cfg: {
    token: string;
    environment: 'sandbox' | 'production';
    onEvent?: (event: unknown) => void;
}): Promise<{
    open(o: CheckoutOptions): void;
}>;

export { type CheckoutItem, type CheckoutOptions, createCheckout };
