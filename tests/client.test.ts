import { beforeEach, describe, expect, it, vi } from 'vitest';

const { open, initializePaddle } = vi.hoisted(() => {
  const open = vi.fn();
  return { open, initializePaddle: vi.fn(async (_cfg?: unknown) => ({ Checkout: { open } })) };
});
vi.mock('@paddle/paddle-js', () => ({ initializePaddle }));

import { createCheckout } from '../src/client';

describe('createCheckout', () => {
  beforeEach(() => { open.mockClear(); initializePaddle.mockClear(); });

  it('passes userId as customData so the webhook can link the subscription', async () => {
    const checkout = await createCheckout({ token: 'test_abc', environment: 'sandbox' });
    checkout.open({ priceId: 'pri_1', userId: 'user_1', email: 'a@x.com', successUrl: 'https://app/ok' });
    expect(initializePaddle).toHaveBeenCalledWith({ token: 'test_abc', environment: 'sandbox' });
    expect(open).toHaveBeenCalledWith({
      items: [{ priceId: 'pri_1', quantity: 1 }],
      customer: { email: 'a@x.com' },
      customData: { userId: 'user_1' },
      settings: { successUrl: 'https://app/ok' },
    });
  });

  it('refuses to open without a userId', async () => {
    const checkout = await createCheckout({ token: 'test_abc', environment: 'sandbox' });
    expect(() => checkout.open({ priceId: 'pri_1', userId: '' })).toThrow(/userId/);
  });

  it('opens with several line items', async () => {
    const checkout = await createCheckout({ token: 'test_abc', environment: 'sandbox' });
    checkout.open({ items: [{ priceId: 'pri_50', quantity: 1 }, { priceId: 'pri_extra', quantity: 12 }], userId: 'org_1' });
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      items: [{ priceId: 'pri_50', quantity: 1 }, { priceId: 'pri_extra', quantity: 12 }],
      customData: { userId: 'org_1' },
    }));
  });

  it('refuses neither or both of priceId and items', async () => {
    const checkout = await createCheckout({ token: 'test_abc', environment: 'sandbox' });
    expect(() => checkout.open({ userId: 'u' } as any)).toThrow(/priceId or items/);
    expect(() => checkout.open({ userId: 'u', priceId: 'p', items: [{ priceId: 'p', quantity: 1 }] } as any)).toThrow(/priceId or items/);
    expect(() => checkout.open({ userId: 'u', items: [] })).toThrow(/priceId or items/);
  });

  it('forwards Paddle.js events to onEvent', async () => {
    const seen: unknown[] = [];
    await createCheckout({ token: 'test_abc', environment: 'sandbox', onEvent: (e) => seen.push(e) });
    const cfg = initializePaddle.mock.calls.at(-1)![0] as { eventCallback?: (e: unknown) => void };
    cfg.eventCallback?.({ name: 'checkout.completed' });
    expect(seen).toEqual([{ name: 'checkout.completed' }]);
  });

  it.each([
    ['test_abc', 'production'],
    ['live_abc', 'sandbox'],
  ] as const)('rejects token %s with environment %s', async (token, environment) => {
    await expect(createCheckout({ token, environment })).rejects.toThrow(/token/);
  });
});
