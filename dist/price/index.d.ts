import { F as FetchLike } from '../paddle-api-D4F0p5Zv.js';
import { PaddleError } from '../catalog/index.js';

interface Price {
    id: string;
    /** Lowest currency unit as a string, e.g. "1500" = 15.00 USD, "1500" = ¥1500. */
    amount: string;
    currency: string;
    /** null for a one-time price. */
    interval: null | {
        interval: 'day' | 'week' | 'month' | 'year';
        frequency: number;
    };
    name: string | null;
    status: 'active' | 'archived';
}
type PriceErrorCode = 'unauthorized' | 'not_found' | 'timeout' | 'network' | 'malformed' | 'http';
/**
 * `unauthorized`: 401/403, or a key that does not match `environment`. `not_found`: 404. `timeout` / `network`: no
 * answer. `malformed`: a 2xx answer that is not a price. `http`: any other status (429, 5xx), in `status`.
 * The message never contains the API key.
 */
declare class PriceError extends PaddleError {
    readonly code: PriceErrorCode;
    name: string;
    constructor(code: PriceErrorCode, message: string, status?: number);
}
interface GetPriceOptions {
    apiKey: string;
    environment: 'sandbox' | 'production';
    fetch?: FetchLike;
    /** Default 5000. */
    timeoutMs?: number;
}
/** `GET /prices/{id}` with the kit's pinned `Paddle-Version`. Throws `PriceError`. */
declare function getPrice(priceId: string, opts: GetPriceOptions): Promise<Price>;
/**
 * Formats a lowest-unit amount with `Intl.NumberFormat`: "1500" USD → "$15", "999" → "$9.99", "1500" JPY → "¥1,500".
 * Zero-decimal currencies are not divided by 100. Whole amounts have no cents.
 */
declare function formatPrice(amount: string | number, currency: string, locale?: string): string;

export { FetchLike, PriceError, formatPrice, getPrice };
export type { GetPriceOptions, Price, PriceErrorCode };
