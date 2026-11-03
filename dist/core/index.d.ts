import { A as Adjustment } from '../types-X8CY_J6w.js';
export { a as AdjustmentContext, C as CheckResult, b as Customer, E as ErrorContext, c as EventStatus, H as Health, d as HealthReport, e as HookContext, L as LineItem, f as LogEntry, g as Logger, O as OwnedIdSet, h as OwnedIds, i as Owns, j as OwnsPredicate, k as OwnsResolver, R as ReasonCode, l as RecoveryFailureReason, m as RecoveryHealth, n as RecoveryState, o as RecoveryStore, S as ScheduledChange, p as SeenTransaction, q as Store, r as Subscription, s as SubscriptionStatus, T as Transaction, U as UnverifiedStats } from '../types-X8CY_J6w.js';
export { B as Billing, a as BillingConfig, c as createBilling } from '../billing-B-_l0_16.js';
export { C as CircuitState, P as PaddleTransport, a as PaddleTransportError, T as TransportOptions, c as createPaddleTransport } from '../transport-DHWsZcN2.js';
import '../paddle-api-qz1847h8.js';

/** Default body cap: just under Vercel's 4.5 MB request limit. A body over it gets 413 `body_too_large`, unread past the cap. */
declare const MAX_WEBHOOK_BODY_BYTES = 4000000;

/**
 * What an adjustment means for what the customer bought:
 * - `revoke`: take back what the transaction granted (an approved full refund, or a chargeback).
 * - `restore`: give back what an earlier adjustment took (a chargeback the seller won, or a reversed refund or
 *   chargeback). Restore only what your app revoked for that transaction; if it revoked nothing, do nothing.
 * - `review`: a person decides (a partial refund, a chargeback warning, an action the kit does not know).
 * - `none`: nothing changes (not approved yet, rejected, a credit, a warning withdrawn).
 * Key the side effect on `adj.adjustmentId` + `adj.status`: the same adjustment arrives again as its status moves.
 */
type AdjustmentEffect = 'revoke' | 'restore' | 'review' | 'none';
declare function adjustmentEffect(adj: Pick<Adjustment, 'action' | 'status' | 'type'>): AdjustmentEffect;
/**
 * Whether a payment stands taken back, judged from EVERY adjustment of its transaction in its latest status: an
 * approved full refund, or more approved chargebacks than approved chargeback reversals. A reversed refund or
 * chargeback no longer counts; a partial refund never does (a person reviews it). Keep each adjustment against its
 * transaction (keyed on `adjustmentId`, even before the payment arrives) and grant what the payment bought only while
 * this is false: deduplicating events cannot do it, because a replay of the same adjustment has another event id.
 */
declare function paymentRevoked(adjustments: ReadonlyArray<Pick<Adjustment, 'action' | 'status' | 'type'>>): boolean;

export { Adjustment, MAX_WEBHOOK_BODY_BYTES, adjustmentEffect, paymentRevoked };
export type { AdjustmentEffect };
