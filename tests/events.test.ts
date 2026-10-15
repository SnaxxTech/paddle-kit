import { describe, expect, it } from 'vitest';
import { parseEvent } from '../src/core/events';
import { loadFixture, subscriptionEvent } from './helpers/fixtures';

describe('parseEvent', () => {
  it('normalises a real subscription.created payload', () => {
    const raw = loadFixture('subscription.created');
    const ev = parseEvent(raw);
    expect(ev?.kind).toBe('subscription');
    if (ev?.kind !== 'subscription') return;
    expect(ev.eventId).toBe(raw.event_id);
    expect(ev.occurredAt).toBe(raw.occurred_at);
    expect(ev.subscription.subscriptionId).toBe(raw.data.id);
    expect(ev.subscription.customerId).toBe(raw.data.customer_id);
    expect(ev.subscription.status).toBe(raw.data.status);
    expect(ev.subscription.priceIds).toEqual(raw.data.items.map((i: any) => i.price.id));
    expect(ev.subscription.userId).toBe('user_1');
    expect(ev.subscription.lastEventAt).toBe(raw.occurred_at);
  });

  it('normalises updated and canceled payloads', () => {
    for (const name of ['subscription.updated', 'subscription.canceled']) {
      const ev = parseEvent(loadFixture(name));
      expect(ev?.kind, name).toBe('subscription');
    }
  });

  it('maps scheduled_change and current_billing_period', () => {
    const ev = parseEvent(
      subscriptionEvent({
        data: {
          scheduled_change: { action: 'cancel', effective_at: '2026-11-01T00:00:00Z', resume_at: null },
          current_billing_period: { starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-11-01T00:00:00Z' },
        },
      }),
    );
    if (ev?.kind !== 'subscription') throw new Error('expected subscription');
    expect(ev.subscription.scheduledChange).toEqual({ action: 'cancel', effectiveAt: '2026-11-01T00:00:00Z' });
    expect(ev.subscription.currentPeriodEnd).toBe('2026-11-01T00:00:00Z');
  });

  it.each([{}, { userId: '' }, { userId: 42 }, null])('treats custom_data %j as no user', (custom) => {
    const ev = parseEvent(subscriptionEvent({ data: { custom_data: custom } }));
    if (ev?.kind !== 'subscription') throw new Error('expected subscription');
    expect(ev.subscription.userId).toBeNull();
  });

  it('treats subscription.imported like a subscription event', () => {
    expect(parseEvent(subscriptionEvent({ eventType: 'subscription.imported' }))?.kind).toBe('subscription');
  });

  it('normalises customer.created', () => {
    const raw = loadFixture('customer.created');
    expect(parseEvent(raw)).toEqual({
      kind: 'customer',
      eventId: raw.event_id,
      eventType: 'customer.created',
      occurredAt: raw.occurred_at,
      customer: { customerId: raw.data.id, email: raw.data.email ?? null, lastEventAt: raw.occurred_at },
    });
  });

  it('records transaction.completed without state', () => {
    expect(parseEvent(loadFixture('transaction.completed'))?.kind).toBe('record-only');
  });

  it('marks unknown event types as ignored', () => {
    expect(parseEvent({ event_id: 'evt_x', event_type: 'payout.paid', occurred_at: '2026-10-15T00:00:00Z', data: {} })?.kind).toBe('ignored');
  });

  it.each([
    ['not an object', 'x'],
    ['no event_id', { event_type: 'subscription.created', occurred_at: '2026-10-15T00:00:00Z', data: {} }],
    ['bad occurred_at', { event_id: 'e', event_type: 'subscription.created', occurred_at: 'yesterday', data: {} }],
    ['unknown status', subscriptionEvent({ data: { status: 'zombie' } })],
    ['items not array', subscriptionEvent({ data: { items: null } })],
    ['missing customer_id', subscriptionEvent({ data: { customer_id: undefined } })],
  ])('returns null for malformed input: %s', (_n, input) => {
    expect(parseEvent(input)).toBeNull();
  });
});
