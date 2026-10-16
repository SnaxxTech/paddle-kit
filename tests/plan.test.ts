import { describe, expect, it } from 'vitest';
import { planOf } from '../src/plan';

const DAY = 86_400_000;
const launch = Date.UTC(2026, 9, 20);
const base = { exempt: false, subscribed: false, launchAt: launch, trialDays: 30 };

describe('planOf', () => {
  it('exempt accounts are always free', () => {
    expect(planOf({ ...base, exempt: true, startedAt: 0, now: launch + 400 * DAY })).toEqual({ kind: 'free' });
  });
  it('exempt wins over a subscription', () => {
    expect(planOf({ ...base, exempt: true, subscribed: true, startedAt: 0, now: launch })).toEqual({ kind: 'free' });
  });
  it('a subscription wins over everything but exempt', () => {
    expect(planOf({ ...base, subscribed: true, startedAt: 0, now: launch + 400 * DAY })).toEqual({ kind: 'paid' });
  });
  it('accounts older than the launch get trialDays from the launch', () => {
    const startedAt = launch - 200 * DAY;
    expect(planOf({ ...base, startedAt, now: launch })).toEqual({ kind: 'trial', endsAt: launch + 30 * DAY, daysLeft: 30 });
    expect(planOf({ ...base, startedAt, now: launch + 30 * DAY - 1 })).toMatchObject({ kind: 'trial', daysLeft: 1 });
    expect(planOf({ ...base, startedAt, now: launch + 30 * DAY })).toEqual({ kind: 'expired', endedAt: launch + 30 * DAY });
  });
  it('accounts started after the launch count from their start', () => {
    const startedAt = launch + 10 * DAY;
    expect(planOf({ ...base, startedAt, now: startedAt + 29 * DAY })).toMatchObject({ kind: 'trial', daysLeft: 1 });
    expect(planOf({ ...base, startedAt, now: startedAt + 31 * DAY })).toEqual({ kind: 'expired', endedAt: startedAt + 30 * DAY });
  });
  it('launchAt null means no launch grace: the trial counts from startedAt (it does not mean free)', () => {
    const startedAt = launch;
    const p = { ...base, launchAt: null, startedAt };
    expect(planOf({ ...p, now: startedAt })).toEqual({ kind: 'trial', endsAt: startedAt + 30 * DAY, daysLeft: 30 });
    expect(planOf({ ...p, now: startedAt + 30 * DAY })).toEqual({ kind: 'expired', endedAt: startedAt + 30 * DAY });
    expect(planOf({ ...p, subscribed: true, now: startedAt + 99 * DAY })).toEqual({ kind: 'paid' });
  });
  it('trialDays 0 means no trial: expired at max(startedAt, launchAt)', () => {
    const p = { ...base, trialDays: 0 };
    expect(planOf({ ...p, startedAt: launch - DAY, now: launch + 5 })).toEqual({ kind: 'expired', endedAt: launch });
    expect(planOf({ ...p, startedAt: launch + DAY, now: launch + 2 * DAY })).toEqual({ kind: 'expired', endedAt: launch + DAY });
    expect(planOf({ ...p, launchAt: null, startedAt: 1000, now: 1000 })).toEqual({ kind: 'expired', endedAt: 1000 });
    expect(planOf({ ...p, subscribed: true, startedAt: 0, now: launch })).toEqual({ kind: 'paid' });
    expect(planOf({ ...p, exempt: true, startedAt: 0, now: launch })).toEqual({ kind: 'free' });
  });
  it('treats a negative or non-finite trialDays as no trial', () => {
    for (const trialDays of [-5, Number.NaN]) {
      expect(planOf({ ...base, trialDays, startedAt: launch, now: launch })).toEqual({ kind: 'expired', endedAt: launch });
    }
  });
});
