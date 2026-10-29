import { Billing } from '../core/index.js';
import { F as FetchLike } from '../paddle-api-D4F0p5Zv.js';
import '../types-BxRTIlXY.js';

/**
 * Re-reads every subscription from the Paddle API and upserts it into the mirror, through the same mapping as the
 * webhook path. Each row carries the API's `updated_at`, so a webhook that occurred later still wins. Web fetch only.
 * `invalid` counts entities the webhook path would also reject (unknown status, missing ids).
 */
declare function reconcile(billing: Billing, opts: {
    apiKey: string;
    fetch?: FetchLike;
}): Promise<{
    scanned: number;
    applied: number;
    notOurs: number;
    invalid: number;
}>;

export { FetchLike, reconcile };
