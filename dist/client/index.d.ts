interface CheckoutOptions {
    priceId: string;
    userId: string;
    email?: string;
    successUrl?: string;
    quantity?: number;
}
declare function createCheckout(cfg: {
    token: string;
    environment: 'sandbox' | 'production';
}): Promise<{
    open(o: CheckoutOptions): void;
}>;

export { type CheckoutOptions, createCheckout };
