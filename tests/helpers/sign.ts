import { createHmac } from 'node:crypto';

export function sign(body: string, secret: string, ts = Math.floor(Date.now() / 1000)): string {
  const h1 = createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
  return `ts=${ts};h1=${h1}`;
}
