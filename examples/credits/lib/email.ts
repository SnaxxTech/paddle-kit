// Replace the body with your email provider's call. Pass `item.id` as its idempotency key: an item can be sent twice
// (a crash after sending, or a send that outlives its lease), and the key keeps the customer from getting two.
export async function sendReceipt(payload: { userId: string }, item: { id: string }): Promise<void> {
  console.info('paddle-kit receipt', item.id, payload.userId);
}
