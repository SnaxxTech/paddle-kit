import { expect, it } from 'vitest';
import { adjustmentEffect } from '../src/core';

// Paddle's adjustment actions and statuses, from developer.paddle.com/api-reference/adjustments (read 2026-10-30).
it.each([
  ['refund', 'pending_approval', 'full', 'none'],
  ['refund', 'rejected', 'full', 'none'],
  ['refund', 'approved', 'full', 'revoke'],
  ['refund', 'approved', 'partial', 'review'],
  ['refund', 'approved', null, 'review'],
  ['refund', 'reversed', 'full', 'restore'],
  ['chargeback', 'approved', 'full', 'revoke'],
  ['chargeback', 'reversed', 'full', 'restore'],
  ['chargeback_reverse', 'approved', 'full', 'restore'],
  ['chargeback_warning', 'approved', 'full', 'review'],
  ['chargeback_warning_reverse', 'approved', 'full', 'none'],
  ['credit', 'approved', 'partial', 'none'],
  ['credit', 'reversed', 'partial', 'none'],
  ['credit_reverse', 'approved', 'partial', 'none'],
  ['something_new', 'approved', 'full', 'review'],
  ['refund', 'some_new_status', 'full', 'review'],
] as const)('%s / %s / %s → %s', (action, status, type, effect) => {
  expect(adjustmentEffect({ action, status, type })).toBe(effect);
});
