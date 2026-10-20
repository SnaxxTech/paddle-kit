import { B as Billing } from '../billing-DX2R5S3A.js';
import { F as FetchLike } from '../paddle-api-BdzICN_K.js';
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
