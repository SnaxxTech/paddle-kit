import { F as FetchLike } from '../billing-BOxBWFZG.js';
import { PaddleError } from '../catalog/index.js';
import { PriceMap } from '../config/index.js';
import '../types-Co0JRFaT.js';
import '../transport-BZ68_7C4.js';

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
type PriceErrorCode = 'unauthorized' | 'not_found' | 'ambiguous' | 'timeout' | 'network' | 'malformed' | 'http';
/**
 * `unauthorized`: 401/403, or a key that does not match `environment`. `not_found`: 404, or no active price with the
 * label. `ambiguous`: more than one active price with the label (since v0.7.0). `timeout` / `network`: no answer.
 * `malformed`: a 2xx answer that is not a price. `http`: any other status (429, 5xx), in `status`.
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
type Cycle = 'monthly' | 'yearly' | 'once';
/**
 * The active price the catalog CLI labelled `<key>-<cycle>` on `app`'s product, as `getPrice` returns it: no price id
 * needed in the app. Throws `PriceError` `not_found` (none) or `ambiguous` (more than one), and the codes of `getPrice`.
 */
declare function findPrice(label: {
    app: string;
    key: string;
    cycle: Cycle;
}, opts: GetPriceOptions): Promise<Price>;
/**
 * Every active price labelled on `app`'s product, as the `PADDLE_PRICES` map the catalog CLI writes: a key with only a
 * one-time price is flat (`{ scan: "pri_…" }`), any other key is a map of cycle to id. `ambiguous` when two active
 * prices share a label. `readBillingEnv({ resolvePrices })` uses it when PADDLE_PRICES is unset.
 */
declare function findPriceMap(app: string, opts: GetPriceOptions): Promise<PriceMap>;
/**
 * Formats a lowest-unit amount with `Intl.NumberFormat`: "1500" USD → "$15", "999" → "$9.99", "1500" JPY → "¥1,500".
 * Zero-decimal currencies are not divided by 100. Whole amounts have no cents.
 */
declare function formatPrice(amount: string | number, currency: string, locale?: string): string;

export { FetchLike, PriceError, PriceMap, findPrice, findPriceMap, formatPrice, getPrice };
export type { Cycle, GetPriceOptions, Price, PriceErrorCode };
