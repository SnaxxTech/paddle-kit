import { describe, expect, it } from 'vitest';
import { Paddle, Environment } from '@paddle/paddle-node-sdk';
import { parseSignatureHeader, verifySignature } from '../src/core/signature';
import { sign } from './helpers/sign';

const SECRET = 'pdl_ntfset_test_secret';
const BODY = '{"event_id":"evt_1","event_type":"subscription.created"}';
const oracle = new Paddle('pdl_sdbx_apikey_unused', { environment: Environment.sandbox });

describe('parseSignatureHeader', () => {
  it('parses ts and one or more h1', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    expect(parseSignatureHeader(`ts=1700000000;h1=${a};h1=${b}`)).toEqual({ ts: 1700000000, h1: [a, b] });
  });
  it.each(['', 'ts=abc;h1=' + 'a'.repeat(64), 'ts=1700000000', 'h1=' + 'a'.repeat(64), 'ts=1;h1=nothex'])(
    'rejects malformed header %j',
    (h) => expect(parseSignatureHeader(h)).toBeNull(),
  );
});

describe('verifySignature', () => {
  it('accepts a valid signature', async () => {
    const header = sign(BODY, SECRET);
    expect(await verifySignature({ rawBody: BODY, header, secret: SECRET })).toEqual({ ok: true });
  });
  it('rejects a missing header', async () => {
    expect(await verifySignature({ rawBody: BODY, header: null, secret: SECRET })).toEqual({ ok: false, reason: 'bad_signature_header' });
  });
  it('rejects a tampered body as signature_mismatch', async () => {
    const header = sign(BODY, SECRET);
    expect(await verifySignature({ rawBody: BODY + ' ', header, secret: SECRET })).toEqual({ ok: false, reason: 'signature_mismatch' });
  });
  it('rejects the wrong secret as signature_mismatch', async () => {
    const header = sign(BODY, 'other_secret');
    expect(await verifySignature({ rawBody: BODY, header, secret: SECRET })).toEqual({ ok: false, reason: 'signature_mismatch' });
  });
  it('reports a forged old header as signature_mismatch, not stale', async () => {
    const old = Math.floor(Date.now() / 1000) - 600;
    const header = sign(BODY, 'other_secret', old);
    expect(await verifySignature({ rawBody: BODY, header, secret: SECRET })).toEqual({ ok: false, reason: 'signature_mismatch' });
  });
  it('rejects a genuine signature older than the tolerance as stale', async () => {
    const ts = 1_700_000_000;
    const header = sign(BODY, SECRET, ts);
    expect(await verifySignature({ rawBody: BODY, header, secret: SECRET, now: (ts + 6) * 1000 })).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(await verifySignature({ rawBody: BODY, header, secret: SECRET, now: (ts + 5) * 1000 })).toEqual({ ok: true });
  });
  it('does not reject a future timestamp (one-sided, same as the SDK)', async () => {
    const ts = 1_700_000_000;
    const header = sign(BODY, SECRET, ts);
    expect(await verifySignature({ rawBody: BODY, header, secret: SECRET, now: (ts - 60) * 1000 })).toEqual({ ok: true });
  });
  it('accepts when any of several h1 values matches (secret rotation)', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const good = sign(BODY, SECRET, ts).split(';')[1];
    const bad = sign(BODY, 'old_secret', ts).split(';')[1];
    expect(await verifySignature({ rawBody: BODY, header: `ts=${ts};${good};${bad}`, secret: SECRET })).toEqual({ ok: true });
  });
});

describe('agrees with the official SDK verifier', () => {
  const now = () => Math.floor(Date.now() / 1000);
  const cases: Array<[string, () => { body: string; header: string }]> = [
    ['valid', () => ({ body: BODY, header: sign(BODY, SECRET, now()) })],
    ['tampered', () => ({ body: BODY + 'x', header: sign(BODY, SECRET, now()) })],
    ['wrong secret', () => ({ body: BODY, header: sign(BODY, 'nope', now()) })],
    ['stale', () => ({ body: BODY, header: sign(BODY, SECRET, now() - 60) })],
    ['unicode body', () => ({ body: '{"name":"Zoë ✓"}', header: sign('{"name":"Zoë ✓"}', SECRET, now()) })],
  ];
  it.each(cases)('%s', async (_name, make) => {
    const { body, header } = make();
    const ours = (await verifySignature({ rawBody: body, header, secret: SECRET })).ok;
    const theirs = await oracle.webhooks.isSignatureValid(body, SECRET, header);
    expect(ours).toBe(theirs);
  });
});
