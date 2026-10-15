type CheckoutItem = {
    priceId: string;
    quantity: number;
};
type CheckoutOptions = {
    userId: string;
    email?: string;
    successUrl?: string;
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
