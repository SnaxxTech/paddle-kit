import { describe, expect, it } from 'vitest';
import { decideAccess, grantsAccess, nextPastDueSince } from '../src/core/access';
import type { Subscription } from '../src/core/types';

const NOW = new Date('2026-10-15T12:00:00Z');
const DAY = 86_400_000;
const sub = (o: Partial<Subscription> = {}): Subscription => ({
  subscriptionId: 'sub_1', customerId: 'ctm_1', userId: 'user_1', status: 'active', priceIds: ['pri_pro'],
  currentPeriodEnd: null, scheduledChange: null, canceledAt: null, pastDueSince: null,
  lastEventAt: '2026-10-01T00:00:00Z', raw: {}, ...o,
});
const policy = { entitlements: { pri_pro: ['pro'], pri_team: ['pro', 'team'] }, pastDueGraceDays: 7 };

describe('grantsAccess', () => {
  it.each([['active', true], ['trialing', true], ['paused', false], ['canceled', false]] as const)('%s → %s', (status, want) => {
    expect(grantsAccess(sub({ status }), NOW, 7)).toBe(want);
  });
  it('keeps access while a cancel is only scheduled (status still active)', () => {
    expect(grantsAccess(sub({ scheduledChange: { action: 'cancel', effectiveAt: '2026-11-01T00:00:00Z' } }), NOW, 7)).toBe(true);
  });
  it('grants past_due inside grace, inclusive of the boundary', () => {
    expect(grantsAccess(sub({ status: 'past_due', pastDueSince: new Date(NOW.getTime() - 7 * DAY).toISOString() }), NOW, 7)).toBe(true);
  });
  it('denies past_due one ms after grace', () => {
    expect(grantsAccess(sub({ status: 'past_due', pastDueSince: new Date(NOW.getTime() - 7 * DAY - 1).toISOString() }), NOW, 7)).toBe(false);
  });
  it('grants past_due with unknown start (treated as just started)', () => {
    expect(grantsAccess(sub({ status: 'past_due', pastDueSince: null }), NOW, 7)).toBe(true);
  });
});

describe('decideAccess', () => {
  it('grants a feature mapped from the price', () => {
    expect(decideAccess([sub()], 'pro', policy, NOW)).toBe(true);
    expect(decideAccess([sub()], 'team', policy, NOW)).toBe(false);
  });
  it('unknown price grants nothing and does not throw', () => {
    expect(decideAccess([sub({ priceIds: ['pri_new_unmapped'] })], 'pro', policy, NOW)).toBe(false);
  });
  it.each(['constructor', '__proto__', 'toString'])('price id %s that collides with an Object.prototype key grants nothing and does not throw', (id) => {
    expect(decideAccess([sub({ priceIds: [id] })], 'pro', policy, NOW)).toBe(false);
  });
  it('multi-item: the mapped item still grants', () => {
    expect(decideAccess([sub({ priceIds: ['pri_addon_unmapped', 'pri_team'] })], 'team', policy, NOW)).toBe(true);
  });
  it('any qualifying subscription is enough', () => {
    expect(decideAccess([sub({ status: 'canceled' }), sub({ subscriptionId: 'sub_2', status: 'trialing' })], 'pro', policy, NOW)).toBe(true);
  });
  it('no subscriptions → false', () => {
    expect(decideAccess([], 'pro', policy, NOW)).toBe(false);
  });
});

describe('nextPastDueSince', () => {
  it('starts the clock on the first past_due', () => {
    expect(nextPastDueSince(sub(), 'past_due', '2026-10-10T00:00:00Z')).toBe('2026-10-10T00:00:00Z');
  });
  it('keeps the original start across repeated past_due events', () => {
    expect(nextPastDueSince(sub({ status: 'past_due', pastDueSince: '2026-10-05T00:00:00Z' }), 'past_due', '2026-10-10T00:00:00Z')).toBe('2026-10-05T00:00:00Z');
  });
  it('clears when leaving past_due', () => {
    expect(nextPastDueSince(sub({ status: 'past_due', pastDueSince: '2026-10-05T00:00:00Z' }), 'active', '2026-10-10T00:00:00Z')).toBeNull();
  });
});
