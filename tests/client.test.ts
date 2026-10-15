import { beforeEach, describe, expect, it, vi } from 'vitest';

const { open, initializePaddle } = vi.hoisted(() => {
  const open = vi.fn();
  return { open, initializePaddle: vi.fn(async () => ({ Checkout: { open } })) };
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

  it.each([
    ['test_abc', 'production'],
    ['live_abc', 'sandbox'],
  ] as const)('rejects token %s with environment %s', async (token, environment) => {
    await expect(createCheckout({ token, environment })).rejects.toThrow(/token/);
  });
});
