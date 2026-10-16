import { describe, expect, it } from 'vitest';
import { customDataOf, itemsOf, parseEvent } from '../src/core/events';
import { loadFixture, subscriptionEvent } from './helpers/fixtures';
import type { Subscription } from '../src/core/types';

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

  it('normalises a real subscription.past_due from a failed renewal', () => {
    const raw = loadFixture('subscription.past_due');
    const ev = parseEvent(raw);
    if (ev?.kind !== 'subscription') throw new Error('expected subscription');
    expect(ev.eventType).toBe('subscription.past_due');
    expect(ev.subscription.status).toBe('past_due');
    expect(ev.subscription.currentPeriodEnd).toBe(raw.data.current_billing_period.ends_at);
    expect(ev.subscription.userId).toBeNull();
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

  it.each(['a\u0000b', '\u0007', 'x\ny', '\u007f'])('treats userId %j (control characters) as no user', (userId) => {
    const ev = parseEvent(subscriptionEvent({ data: { custom_data: { userId } } }));
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

  it('normalises transaction.completed as a transaction event (v0.2: record-only)', () => {
    expect(parseEvent(loadFixture('transaction.completed'))?.kind).toBe('transaction');
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

  describe('transactions and adjustments', () => {
    it('normalises a real transaction.completed (items with quantity, currency, grand total)', () => {
      const raw = loadFixture('transaction.completed');
      const ev = parseEvent(raw);
      expect(ev?.kind).toBe('transaction');
      if (ev?.kind !== 'transaction') return;
      expect(ev.eventId).toBe(raw.event_id);
      expect(ev.transaction).toEqual({
        transactionId: 'txn_01hv8wptq8987qeep44cyrewp9',
        status: 'completed',
        customerId: 'ctm_01hv6y1jedq4p1n0yqn5ba3ky4',
        subscriptionId: 'sub_01hv8x29kz0t586xy6zn1a62ny',
        customData: null,
        items: [
          { priceId: 'pri_01gsz8x8sawmvhz1pv30nge1ke', productId: 'pro_01gsz4t5hdjse780zja8vvr7jg', quantity: 10 },
          { priceId: 'pri_01h1vjfevh5etwq3rb416a23h2', productId: 'pro_01h1vjes1y163xfj1rh1tkfb65', quantity: 1 },
          { priceId: 'pri_01gsz98e27ak2tyhexptwc58yk', productId: 'pro_01gsz97mq9pa4fkyy0wqenepkz', quantity: 1 },
        ],
        currency: 'USD',
        total: '65215',
        occurredAt: raw.occurred_at,
        raw: raw.data,
      });
    });

    it('parses transaction.paid like transaction.completed, reads custom_data, falls back to details.totals.total', () => {
      const raw = loadFixture('transaction.completed');
      raw.event_type = 'transaction.paid';
      raw.data.custom_data = { userId: 'user_9', order_id: 'ord_1' };
      delete raw.data.details.totals.grand_total;
      raw.data.subscription_id = null;
      const ev = parseEvent(raw);
      if (ev?.kind !== 'transaction') throw new Error('expected transaction');
      expect(ev.transaction.customData).toEqual({ userId: 'user_9', order_id: 'ord_1' });
      expect(ev.transaction.total).toBe('65215');
      expect(ev.transaction.subscriptionId).toBeNull();
    });

    it('defaults a missing quantity to 1 and skips items without a price id', () => {
      const raw = loadFixture('transaction.completed');
      raw.data.items = [{ price: { id: 'pri_a', product_id: 'pro_a' } }, { price: null, quantity: 3 }, { quantity: 2 }];
      const ev = parseEvent(raw);
      if (ev?.kind !== 'transaction') throw new Error('expected transaction');
      expect(ev.transaction.items).toEqual([{ priceId: 'pri_a', productId: 'pro_a', quantity: 1 }]);
    });

    it('gives null totals/currency when details are absent', () => {
      const raw = loadFixture('transaction.completed');
      delete raw.data.details;
      delete raw.data.currency_code;
      const ev = parseEvent(raw);
      if (ev?.kind !== 'transaction') throw new Error('expected transaction');
      expect(ev.transaction.total).toBeNull();
      expect(ev.transaction.currency).toBeNull();
    });

    it('returns null for a transaction without data.id', () => {
      const raw = loadFixture('transaction.completed');
      delete raw.data.id;
      expect(parseEvent(raw)).toBeNull();
    });

    it('normalises the adjustment.created docs example', () => {
      const raw = loadFixture('adjustment.created');
      const ev = parseEvent(raw);
      expect(ev?.kind).toBe('adjustment');
      if (ev?.kind !== 'adjustment') return;
      expect(ev.adjustment).toEqual({
        adjustmentId: 'adj_01hvgf2s84dr6reszzg29zbvcm',
        action: 'refund',
        status: 'pending_approval',
        transactionId: 'txn_01hvcc93znj3mpqt1tenkjb04y',
        subscriptionId: 'sub_01hvccbx32q2gb40sqx7n42430',
        customerId: 'ctm_01hv6y1jedq4p1n0yqn5ba3ky4',
        currency: 'USD',
        total: '100',
        occurredAt: raw.occurred_at,
        raw: raw.data,
      });
    });

    it('parses adjustment.updated and tolerates a null subscription_id', () => {
      const raw = loadFixture('adjustment.created');
      raw.event_type = 'adjustment.updated';
      raw.data.status = 'approved';
      raw.data.subscription_id = null;
      const ev = parseEvent(raw);
      if (ev?.kind !== 'adjustment') throw new Error('expected adjustment');
      expect(ev.adjustment.status).toBe('approved');
      expect(ev.adjustment.subscriptionId).toBeNull();
    });

    it.each(['id', 'transaction_id'])('returns null for an adjustment without data.%s', (field) => {
      const raw = loadFixture('adjustment.created');
      delete raw.data[field];
      expect(parseEvent(raw)).toBeNull();
    });

    it('itemsOf and customDataOf read the stored subscription raw', () => {
      const raw = loadFixture('subscription.created');
      const ev = parseEvent(raw);
      if (ev?.kind !== 'subscription') throw new Error('expected subscription');
      const sub = { ...ev.subscription, pastDueSince: null };
      expect(itemsOf(sub)).toEqual(
        raw.data.items.map((i: any) => ({ priceId: i.price.id, productId: i.price.product_id, quantity: i.quantity ?? 1 })),
      );
      expect(itemsOf(sub).length).toBeGreaterThan(0);
      expect(customDataOf(sub)).toEqual({ userId: 'user_1' });
    });

    it('itemsOf and customDataOf are safe on an empty or foreign raw', () => {
      const base: Subscription = { subscriptionId: 's', customerId: 'c', userId: null, status: 'active', priceIds: [], currentPeriodEnd: null, scheduledChange: null, canceledAt: null, pastDueSince: null, lastEventAt: 'x', raw: null };
      expect(itemsOf({ ...base, raw: null })).toEqual([]);
      expect(itemsOf({ ...base, raw: { items: 'nope' } })).toEqual([]);
      expect(customDataOf({ ...base, raw: null })).toBeNull();
      expect(customDataOf({ ...base, raw: { custom_data: [] } })).toBeNull();
    });
  });
});
