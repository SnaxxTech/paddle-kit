import { describe, expect, it } from 'vitest';
import { createBilling } from '../src/core/billing';
import { memoryStore } from '../src/memory';
import { createWebhookRoute } from '../src/next';
import { diagnose, main, parseArgs, type DoctorFetch } from '../src/doctor/cli';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const URL_ = 'https://app.example.com/api/paddle';
const TOKEN = 'health-token-1234';
const health = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    lastEventAt: '2026-10-29T09:00:00.000Z',
    lastFailureAt: null,
    lastFailureReason: null,
    failedLast24h: 0,
    unlinkedLast24h: 0,
    lastOwnedAt: '2026-10-29T09:00:00.000Z',
    notOursLast24h: 0,
    kitVersion: '0.6.0',
    environment: 'production',
    ...over,
  });

async function run(argv: string[], fetch: DoctorFetch, env: Record<string, string> = {}) {
  const lines: string[] = [];
  const orig = { log: console.log, error: console.error };
  console.log = console.error = (...a: unknown[]) => void lines.push(a.join(' '));
  try {
    return { code: await main(argv, { fetch, env, now: NOW }), output: lines.join('\n') };
  } finally {
    Object.assign(console, orig);
  }
}
const answer = (status: number, body = '', headers: Record<string, string> = {}) =>
  async () => ({ status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => body });

describe('diagnose', () => {
  it('a healthy report: OK, with the last event and its age', () => {
    const d = diagnose(200, health(), { now: NOW });
    expect(d.ok).toBe(true);
    expect(d.lines).toEqual([
      'Reachable: yes',
      'Billing: on (production), paddle-kit 0.6.0',
      'Last event: 2026-10-29T09:00:00.000Z (3 h ago)',
      'Last failure: none',
      'Failed in the last 24 h: 0',
    ]);
  });

  it('no event yet is not a problem', () => {
    const d = diagnose(200, health({ lastEventAt: null }), { now: NOW });
    expect(d.ok).toBe(true);
    expect(d.lines).toContain('Last event: none yet (normal right after the first deploy; send a simulator event)');
  });

  it('a recent signature_mismatch, store_error or hook_error is a problem, in plain words', () => {
    for (const reason of ['signature_mismatch', 'store_error', 'hook_error']) {
      const d = diagnose(200, health({ lastFailureReason: reason, lastFailureAt: '2026-10-29T11:30:00.000Z', failedLast24h: 2 }), { now: NOW });
      expect(d.ok).toBe(false);
      expect(d.lines.at(-1)).toMatch(new RegExp(`^PROBLEM: ${reason} in the last 24 h: `));
    }
    const d = diagnose(200, health({ lastFailureReason: 'signature_mismatch', lastFailureAt: '2026-10-29T11:30:00.000Z', failedLast24h: 1 }), { now: NOW });
    expect(d.lines).toContain(
      'Last failure: signature_mismatch: the webhook secret on the host does not match the Paddle notification destination, at 2026-10-29T11:30:00.000Z (30 min ago)',
    );
    expect(d.lines).toContain('Failed in the last 24 h: 1 (bots on a public URL count too)');
  });

  it('an old setup failure, or a bot-shaped one, is shown but not a problem', () => {
    expect(diagnose(200, health({ lastFailureReason: 'signature_mismatch', lastFailureAt: '2026-10-25T00:00:00.000Z' }), { now: NOW }).ok).toBe(true);
    const bot = diagnose(200, health({ lastFailureReason: 'bad_signature_header', lastFailureAt: '2026-10-29T11:59:00.000Z', failedLast24h: 1 }), { now: NOW });
    expect(bot.ok).toBe(true);
    expect(bot.lines).toContain('Last failure: bad_signature_header: a request had no valid Paddle-Signature header (often a bot, not Paddle), at 2026-10-29T11:59:00.000Z (1 min ago)');
  });

  it('unlinked subscriptions are a warning', () => {
    const d = diagnose(200, health({ unlinkedLast24h: 2 }), { now: NOW });
    expect(d.ok).toBe(true);
    expect(d.lines).toContain('WARNING: 2 subscription event(s) without a userId in 24 h: open each checkout with createCheckout');
  });

  it('every non-200 answer of the route is a problem with its own words', () => {
    const cases: Array<[number, string, RegExp, { sentToken?: boolean }?]> = [
      [401, '', /--token differs from PADDLE_HEALTH_TOKEN on the host/],
      [401, '', /needs a token: pass --token/, { sentToken: false }],
      [404, '{"error":"billing_off"}', /billing is OFF on this deployment: no billing variable is set on the host/],
      [404, '{"error":"health_off"}', /health route is off: set PADDLE_HEALTH_TOKEN on the host/],
      [404, '<html>Not found</html>', /no paddle-kit route at this URL/],
      [503, '{"error":"store_error"}', /database is not reachable/],
      [503, '', /misconfigured on the host \(503\)\. To see the variable names, pass healthToken/],
      [500, 'oops', /unexpected answer: HTTP 500/],
      [200, '{"hello":1}', /unexpected answer: HTTP 200/],
      [200, 'not json', /unexpected answer: HTTP 200/],
    ];
    for (const [status, body, match, opts] of cases) {
      const d = diagnose(status, body, { now: NOW, ...opts });
      expect(d.ok).toBe(false);
      expect(d.lines.join('\n')).toMatch(match);
    }
  });

  it('a misconfigured route lists the problem names', () => {
    const d = diagnose(503, JSON.stringify({ error: 'misconfigured', problems: ['PADDLE_PRICES is missing', 'NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is missing'] }));
    expect(d).toEqual({
      ok: false,
      lines: ['Reachable: yes', 'PROBLEM: billing is misconfigured on the host:', 'PROBLEM:   PADDLE_PRICES is missing', 'PROBLEM:   NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is missing'],
    });
  });
});

describe('paddle-kit-doctor main', () => {
  it('sends the bearer token with manual redirects, exits 0 on a healthy report, never prints the token', async () => {
    const seen: Array<{ url: string; init: any }> = [];
    const r = await run(['--url', URL_, '--token', TOKEN], async (url, init) => {
      seen.push({ url, init });
      return answer(200, health())();
    });
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(URL_);
    expect(seen[0]!.init.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(seen[0]!.init.redirect).toBe('manual');
    expect(seen[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(r.output).toContain('Result: OK');
    expect(r.output).not.toContain(TOKEN);
  });

  it('reads the token from PADDLE_HEALTH_TOKEN; without one it says so and sends no header', async () => {
    let headers: Record<string, string> = {};
    await run(['--url', URL_], async (_u, init) => ((headers = init.headers), answer(200, health())()), { PADDLE_HEALTH_TOKEN: TOKEN });
    expect(headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    const r = await run(['--url', URL_], async (_u, init) => ((headers = init.headers), answer(401)()));
    expect(headers).toEqual({});
    expect(r.code).toBe(1);
    expect(r.output).toContain('Note: no token');
    expect(r.output).toContain('needs a token: pass --token');
  });

  it('exits 1 on a problem report', async () => {
    const r = await run(['--url', URL_, '--token', TOKEN], answer(404, '{"error":"billing_off"}'));
    expect(r.code).toBe(1);
    expect(r.output).toContain('Result: PROBLEM (exit 1)');
  });

  it('not reachable: network failure and timeout, exit 1, without the error text', async () => {
    const down = await run(['--url', URL_, '--token', TOKEN], async () => {
      throw new TypeError(`getaddrinfo ENOTFOUND ${TOKEN}`);
    });
    expect(down.code).toBe(1);
    expect(down.output).toContain('Reachable: no (DNS, TLS or connection failure)');
    expect(down.output).not.toContain(TOKEN);

    const slow = await run(['--url', URL_, '--token', TOKEN, '--timeout', '20'], (_u, init) =>
      new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
    );
    expect(slow.code).toBe(1);
    expect(slow.output).toContain('Reachable: no (no answer in 20 ms)');
  });

  it('a redirect is a problem and is not followed', async () => {
    let calls = 0;
    const r = await run(['--url', URL_, '--token', TOKEN], async () => (calls++, answer(308, '', { location: 'https://www.app.example.com/api/paddle' })()));
    expect([r.code, calls]).toEqual([1, 1]);
    expect(r.output).toContain('PROBLEM: HTTP 308 redirect to https://www.app.example.com/api/paddle');
  });

  it('refuses a non-https URL (except localhost), a bad URL and bad flags before any request', async () => {
    let calls = 0;
    const fetch = async () => (calls++, answer(200, health())());
    for (const argv of [['--url', 'http://app.example.com/api/paddle'], ['--url', 'nope'], [], ['--url'], ['--what'], ['--url', URL_, '--timeout', 'soon']]) {
      expect((await run(argv, fetch)).code).toBe(1);
    }
    expect(calls).toBe(0);
    expect((await run(['--url', 'http://localhost:3000/api/paddle', '--token', TOKEN], fetch)).code).toBe(0);
    expect((await run(['--help'], fetch)).output).toContain('--url <url>');
    expect(parseArgs(['--url', URL_, '--token', 't', '--timeout', '500'])).toEqual({ url: URL_, token: 't', timeoutMs: 500, help: false });
  });

  it('end to end against createWebhookRoute: off, misconfigured with names, and on', async () => {
    const viaRoute = (route: { GET(r: Request): Promise<Response> }) => async (url: string, init: { headers: Record<string, string> }) => {
      const res = await route.GET(new Request(url, { headers: init.headers }));
      return { status: res.status, headers: res.headers, text: () => res.text() };
    };
    const off = await run(['--url', URL_, '--token', TOKEN], viaRoute(createWebhookRoute({ billing: null, problems: [] })));
    expect([off.code, off.output.includes('billing is OFF')]).toEqual([1, true]);

    const bad = await run(['--url', URL_, '--token', TOKEN], viaRoute(createWebhookRoute({ billing: null, problems: ['PADDLE_PRICES is missing'], healthToken: TOKEN })));
    expect(bad.code).toBe(1);
    expect(bad.output).toContain('PROBLEM:   PADDLE_PRICES is missing');

    const billing = createBilling({ environment: 'sandbox', webhookSecret: 's', store: memoryStore(), entitlements: {}, healthToken: TOKEN, log: () => {} });
    const on = await run(['--url', URL_, '--token', TOKEN], viaRoute(createWebhookRoute({ billing, problems: [] })));
    expect(on.code).toBe(0);
    expect(on.output).toContain('Billing: on (sandbox), paddle-kit 0.6.0');
    expect(on.output).toContain('Last event: none yet');
  });
});
