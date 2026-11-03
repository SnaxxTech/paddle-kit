import type { Adjustment } from './types';

/**
 * What an adjustment means for what the customer bought:
 * - `revoke`: take back what the transaction granted (an approved full refund, or a chargeback).
 * - `restore`: give back what an earlier adjustment took (a chargeback the seller won, or a reversed refund or
 *   chargeback). Restore only what your app revoked for that transaction; if it revoked nothing, do nothing.
 * - `review`: a person decides (a partial refund, a chargeback warning, an action the kit does not know).
 * - `none`: nothing changes (not approved yet, rejected, a credit, a warning withdrawn).
 * Key the side effect on `adj.adjustmentId` + `adj.status`: the same adjustment arrives again as its status moves.
 */
export type AdjustmentEffect = 'revoke' | 'restore' | 'review' | 'none';

export function adjustmentEffect(adj: Pick<Adjustment, 'action' | 'status' | 'type'>): AdjustmentEffect {
  if (adj.status === 'pending_approval' || adj.status === 'rejected') return 'none';
  if (adj.status === 'reversed') return adj.action === 'refund' || adj.action === 'chargeback' ? 'restore' : 'none';
  if (adj.status !== 'approved') return 'review';
  switch (adj.action) {
    case 'refund':
      return adj.type === 'full' ? 'revoke' : 'review';
    case 'chargeback':
      return 'revoke';
    case 'chargeback_reverse':
      return 'restore';
    case 'chargeback_warning':
      return 'review';
    case 'chargeback_warning_reverse':
    case 'credit':
    case 'credit_reverse':
      return 'none';
    default:
      return 'review';
  }
}

/**
 * Whether a payment stands taken back, judged from EVERY adjustment of its transaction in its latest status: an
 * approved full refund, or more approved chargebacks than approved chargeback reversals. A reversed refund or
 * chargeback no longer counts; a partial refund never does (a person reviews it). Keep each adjustment against its
 * transaction (keyed on `adjustmentId`, even before the payment arrives) and grant what the payment bought only while
 * this is false: deduplicating events cannot do it, because a replay of the same adjustment has another event id.
 */
export function paymentRevoked(adjustments: ReadonlyArray<Pick<Adjustment, 'action' | 'status' | 'type'>>): boolean {
  const approved = adjustments.filter((a) => a.status === 'approved');
  const count = (action: string) => approved.filter((a) => a.action === action).length;
  return approved.some((a) => a.action === 'refund' && a.type === 'full') || count('chargeback') > count('chargeback_reverse');
}
