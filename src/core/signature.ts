import type { ReasonCode } from './types';

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: Extract<ReasonCode, 'bad_signature_header' | 'signature_mismatch' | 'stale_timestamp'> };

const encoder = new TextEncoder();

export function parseSignatureHeader(header: string): { ts: number; h1: string[] } | null {
  let ts: number | undefined;
  const h1: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 'ts' && /^\d+$/.test(value)) ts = Number(value);
    else if (key === 'h1' && /^[0-9a-f]{64}$/i.test(value)) h1.push(value.toLowerCase());
  }
  return ts !== undefined && h1.length > 0 ? { ts, h1 } : null;
}

export async function verifySignature(input: {
  rawBody: string;
  header: string | null;
  secret: string;
  toleranceSeconds?: number;
  now?: number;
}): Promise<VerifyResult> {
  const parsed = input.header ? parseSignatureHeader(input.header) : null;
  if (!parsed) return { ok: false, reason: 'bad_signature_header' };

  const key = await crypto.subtle.importKey('raw', encoder.encode(input.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${parsed.ts}:${input.rawBody}`)));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  if (!parsed.h1.some((candidate) => constantTimeEqual(candidate, expected))) {
    return { ok: false, reason: 'signature_mismatch' };
  }

  const tolerance = input.toleranceSeconds ?? 5;
  const now = input.now ?? Date.now();
  if (now > (parsed.ts + tolerance) * 1000) return { ok: false, reason: 'stale_timestamp' };
  return { ok: true };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
