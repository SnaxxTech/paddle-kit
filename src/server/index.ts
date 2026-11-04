// Server-only Paddle calls an app makes for its users (since v0.8.4): a checkout transaction created on the server,
// and a customer portal session. Edge-safe (web fetch only). Needs PADDLE_API_KEY: never import it in the browser.
import { LIVE_BASE, PaddleError, SANDBOX_BASE, paddleClient, type FetchLike } from '../core/paddle-api';

export { PaddleError, type FetchLike };

export interface PaddleApi {
  /** PADDLE_API_KEY (`pdl_sdbx_…` for sandbox, `pdl_live_…` for production). */
  apiKey: string;
  environment: 'sandbox' | 'production';
  /** Default: global fetch. Pass `transport.fetch` (from `billingFromEnv`) for retries of GETs and a circuit breaker. */
  fetch?: FetchLike;
}

function client(api: PaddleApi) {
  const keyEnv = api.apiKey.startsWith('pdl_live_') ? 'production' : api.apiKey.startsWith('pdl_sdbx_') ? 'sandbox' : null;
  if (keyEnv !== api.environment) throw new PaddleError(`the API key is not a ${api.environment} key`);
  const fetchImpl: FetchLike = api.fetch ?? ((url, init) => fetch(url, init));
  return paddleClient(api.environment === 'production' ? LIVE_BASE : SANDBOX_BASE, api.apiKey, fetchImpl, [api.apiKey]);
}

export interface CheckoutTransactionOptions {
  /** From your server session, never from the request: it is written to `custom_data.userId`. */
  userId: string;
  items: { priceId: string; quantity: number }[];
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
export async function createCheckoutTransaction(api: PaddleApi, o: CheckoutTransactionOptions): Promise<{ transactionId: string; checkoutUrl: string | null }> {
  if (!o.userId) throw new PaddleError('userId is required so the purchase can be linked to the user');
  if (!Array.isArray(o.items) || o.items.length === 0) throw new PaddleError('a checkout needs at least one item');
  for (const i of o.items) {
    if (!Number.isInteger(i.quantity) || i.quantity < 1) throw new PaddleError(`quantity for ${i.priceId} must be a whole number of at least 1`);
    if (o.allowedPriceIds && !o.allowedPriceIds.includes(i.priceId)) throw new PaddleError(`price ${i.priceId} is not for sale`);
  }
  const res = await client(api).call('POST', '/transactions', {
    items: o.items.map((i) => ({ price_id: i.priceId, quantity: i.quantity })),
    ...(o.customerId ? { customer_id: o.customerId } : {}),
    collection_mode: 'automatic',
    custom_data: { ...o.customData, userId: o.userId },
  });
  const id = res.data?.id;
  if (typeof id !== 'string' || !id.startsWith('txn_')) throw new PaddleError('Paddle answered with no transaction id');
  const url = res.data?.checkout?.url;
  return { transactionId: id, checkoutUrl: typeof url === 'string' ? url : null };
}

const PORTAL = /^https:\/\/(sandbox-)?customer-portal\.paddle\.com\//;

function portalUrl(u: unknown): string {
  if (typeof u !== 'string' || !PORTAL.test(u)) throw new PaddleError('Paddle answered with a link that is not a Paddle customer portal link');
  return u;
}

/**
 * A fresh customer portal session (create one per click: the links are personal and expire). Only links on Paddle's
 * own portal host (`customer-portal.paddle.com`, or `sandbox-customer-portal.paddle.com`) are returned; anything else
 * throws, so the app never redirects a user elsewhere. Look the customer up from your own records, never the request.
 */
export async function customerPortalSession(
  api: PaddleApi,
  o: { customerId: string; subscriptionIds?: readonly string[] },
): Promise<{ overview: string; subscriptions: Record<string, { cancel: string; updatePaymentMethod: string }> }> {
  if (!/^ctm_[a-z\d]+$/.test(o.customerId)) throw new PaddleError('customerId must be a Paddle customer id (ctm_…)');
  const res = await client(api).call('POST', `/customers/${o.customerId}/portal-sessions`, { subscription_ids: [...(o.subscriptionIds ?? [])] });
  const urls = res.data?.urls;
  const subscriptions: Record<string, { cancel: string; updatePaymentMethod: string }> = {};
  for (const s of Array.isArray(urls?.subscriptions) ? urls.subscriptions : []) {
    subscriptions[String(s.id)] = { cancel: portalUrl(s.cancel_subscription), updatePaymentMethod: portalUrl(s.update_subscription_payment_method) };
  }
  return { overview: portalUrl(urls?.general?.overview), subscriptions };
}

/**
 * Cancels a subscription (since v0.9.2), immediately by default: Paddle sets it `canceled` and the
 * `subscription.canceled` webhook ends access. Paddle never cancels a subscription because a payment was refunded or
 * charged back; the subscription starter calls this from `onAdjustment` for an approved full refund or a chargeback.
 * A canceled subscription cannot be reinstated (a won dispute does not bring it back). Needs `subscription.write`.
 * Idempotent: when Paddle refuses because the subscription is already canceled (a replay, or a second refund or
 * chargeback before the canceled webhook arrives), it answers `{ status: 'canceled' }` instead of throwing.
 */
export async function cancelSubscription(api: PaddleApi, subscriptionId: string, o: { effectiveFrom?: 'immediately' | 'next_billing_period' } = {}): Promise<{ status: string }> {
  if (!/^sub_[a-z\d]+$/.test(subscriptionId)) throw new PaddleError('subscriptionId must be a Paddle subscription id (sub_…)');
  const paddle = client(api);
  try {
    const res = await paddle.call('POST', `/subscriptions/${subscriptionId}/cancel`, { effective_from: o.effectiveFrom ?? 'immediately' });
    return { status: String(res.data?.status ?? '') };
  } catch (error) {
    if (!(error instanceof PaddleError) || error.status === undefined || error.status >= 500) throw error;
    // Refused: read the subscription. Already canceled is the outcome we wanted; anything else is a real failure.
    const now = await paddle.call('GET', `/subscriptions/${subscriptionId}`).catch(() => null);
    if (now?.data?.status === 'canceled') return { status: 'canceled' };
    throw error;
  }
}
