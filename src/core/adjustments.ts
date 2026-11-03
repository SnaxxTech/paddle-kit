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
