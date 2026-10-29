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

async function run(argv: string[], fetch: DoctorFetch, env: Record<string, string> = {}, files: Record<string, string> = {}) {
  const lines: string[] = [];
  const orig = { log: console.log, error: console.error };
  console.log = console.error = (...a: unknown[]) => void lines.push(a.join(' '));
  const readFile = (f: string) => {
    if (!(f in files)) throw new Error(`ENOENT ${f}`);
    return files[f]!;
  };
  try {
    return { code: await main(argv, { fetch, env, now: NOW, readFile }), output: lines.join('\n') };
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
    expect(on.output).toContain('Billing: on (sandbox), paddle-kit 0.7.0');
    expect(on.output).toContain('Last event: none yet');
  });
});

describe('diagnose: v0.7.0 health fields', () => {
  it('staleHours: no verified event for longer is a problem; younger is fine; none yet is a problem once staleHours is set', () => {
    expect(diagnose(200, health(), { now: NOW, staleHours: 4 }).ok).toBe(true);
    const stale = diagnose(200, health(), { now: NOW, staleHours: 2 });
    expect(stale.ok).toBe(false);
    expect(stale.lines.at(-1)).toBe('PROBLEM: no verified event for more than 2 h: check the webhook secret and the Paddle notification destination');
    expect(diagnose(200, health({ lastEventAt: null }), { now: NOW, staleHours: 2 }).ok).toBe(false);
  });

  it('unverified rejections are shown, and a signature_mismatch among them is a warning, not a problem (bots can send it)', () => {
    const d = diagnose(200, health({ unverified: { since: '2026-10-29T10:00:00.000Z', count: 7, byReason: { bad_signature_header: 5, signature_mismatch: 2 }, lastAt: null, lastReason: null } }), { now: NOW });
    expect(d.ok).toBe(true);
    expect(d.lines).toContain('Refused before the signature check: 7 since 2026-10-29T10:00:00.000Z, on the server instance that answered (bad_signature_header 5, signature_mismatch 2)');
    expect(d.lines.some((l) => l.startsWith('WARNING: signature_mismatch'))).toBe(true);
    expect(diagnose(200, health({ unverified: { since: 'x', count: 0, byReason: {}, lastAt: null, lastReason: null } }), { now: NOW }).lines.join()).not.toContain('Refused');
  });

  it('app checks: ok ones are lines, a failed one is a problem with its detail', () => {
    const d = diagnose(200, health({ checks: { price: { ok: true, detail: 'paddle' }, db: { ok: false, detail: 'fallback: timeout' } } }), { now: NOW });
    expect(d.ok).toBe(false);
    expect(d.lines).toContain('Check price: ok (paddle)');
    expect(d.lines).toContain('PROBLEM: check "db" failed: fallback: timeout');
  });

  it('a recent prices_unavailable is a problem in plain words', () => {
    const d = diagnose(200, health({ lastFailureReason: 'prices_unavailable', lastFailureAt: '2026-10-29T11:00:00.000Z', failedLast24h: 1 }), { now: NOW });
    expect(d.ok).toBe(false);
    expect(d.lines.at(-1)).toMatch(/^PROBLEM: prices_unavailable in the last 24 h: the app could not find its price ids in Paddle/);
  });
});

describe('paddle-kit-doctor --apps', () => {
  const APPS = JSON.stringify([
    { name: 'leakscan', url: 'https://leakscan.example/api/paddle', tokenEnv: 'LEAKSCAN_TOKEN', staleHours: 48 },
    { name: 'offday', url: 'https://offday.example/api/paddle', tokenEnv: 'OFFDAY_TOKEN', staleHours: 1 },
    { name: 'qrlab', url: 'https://qrlab.example/api/paddle', tokenEnv: 'QRLAB_TOKEN' },
  ]);
  const ENV = { LEAKSCAN_TOKEN: 'tok-leakscan-1234', OFFDAY_TOKEN: 'tok-offday-5678', QRLAB_TOKEN: 'tok-qrlab-9012' };
  // Each host answers its own report; the bearer token must be that app's own.
  const hosts: Record<string, [string, number, string]> = {
    'leakscan.example': ['tok-leakscan-1234', 200, health({ checks: { price: { ok: true, detail: 'paddle' } } })],
    'offday.example': ['tok-offday-5678', 200, health()], // last event 3 h ago, staleHours 1
    'qrlab.example': ['tok-qrlab-9012', 503, JSON.stringify({ error: 'misconfigured', problems: ['PADDLE_PRICES is missing'] })],
  };
  const fleet: DoctorFetch = async (url, init) => {
    const [token, status, body] = hosts[new URL(url).hostname]!;
    expect(init.redirect).toBe('manual');
    return init.headers.authorization === `Bearer ${token}` ? answer(status, body)() : answer(401)();
  };

  it('prints one row per app and every problem, exits 1 when any app is red, and never prints a token', async () => {
    const r = await run(['--apps', 'apps.json'], fleet, ENV, { 'apps.json': APPS });
    expect(r.code).toBe(1);
    const lines = r.output.split('\n');
    expect(lines[0]).toMatch(/^APP +RESULT +REACHABLE +ENV +LAST EVENT +FAILED 24H +CHECKS$/);
    expect(lines[1]).toMatch(/^leakscan +OK +yes +ok +3 h ago +0 +price ok$/);
    expect(lines[2]).toMatch(/^offday +PROBLEM +yes +ok +3 h ago STALE \(>1 h\) +0 +-$/);
    expect(lines[3]).toMatch(/^qrlab +PROBLEM +yes +1 problem\(s\) +- +- +-$/);
    expect(r.output).toContain('offday: PROBLEM: no verified event for more than 1 h');
    expect(r.output).toContain('qrlab: PROBLEM:   PADDLE_PRICES is missing');
    expect(lines.at(-1)).toBe('Result: PROBLEM in offday, qrlab (exit 1)');
    for (const t of Object.values(ENV)) expect(r.output).not.toContain(t);
  });

  it('--json: one machine-readable result per app (no token, only its variable name), for a job that opens one issue per red app', async () => {
    const r = await run(['--apps', 'apps.json', '--json'], fleet, ENV, { 'apps.json': APPS });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.output);
    expect(out.ok).toBe(false);
    expect(out.checkedAt).toBe(new Date(NOW).toISOString());
    expect(out.apps.map((a: any) => [a.name, a.ok])).toEqual([['leakscan', true], ['offday', false], ['qrlab', false]]);
    expect(out.apps[0]).toMatchObject({
      url: 'https://leakscan.example/api/paddle', tokenEnv: 'LEAKSCAN_TOKEN', reachable: true, httpStatus: 200, billing: 'on', environment: 'production',
      kitVersion: '0.6.0', lastEventAt: '2026-10-29T09:00:00.000Z', lastEventAgeHours: 3, staleHours: 48, stale: false, failedLast24h: 0,
      checks: { price: { ok: true, detail: 'paddle' } }, problems: [],
    });
    expect(out.apps[1]).toMatchObject({ stale: true, problems: ['no verified event for more than 1 h: check the webhook secret and the Paddle notification destination'] });
    expect(out.apps[2]).toMatchObject({ billing: 'misconfigured', envProblems: ['PADDLE_PRICES is missing'], stale: null });
    expect(out.apps[2].problems).toEqual(['billing is misconfigured on the host:', '  PADDLE_PRICES is missing']);
    expect('lines' in out.apps[0]).toBe(false);
    for (const t of Object.values(ENV)) expect(r.output).not.toContain(t);
  });

  it('all green: exit 0', async () => {
    const one = JSON.stringify([{ name: 'leakscan', url: 'https://leakscan.example/api/paddle', tokenEnv: 'LEAKSCAN_TOKEN' }]);
    const r = await run(['--apps', 'a.json'], fleet, ENV, { 'a.json': one });
    expect([r.code, r.output.split('\n').at(-1)]).toEqual([0, 'Result: OK (1 app)']);
  });

  it('a token variable that is not set: that app is red, with no request; unreachable and refused apps are red too', async () => {
    const seen: string[] = [];
    const r = await run(['--apps', 'apps.json', '--json'], async (url, init) => {
      seen.push(new URL(url).hostname);
      if (url.includes('offday')) throw new TypeError(`ECONNREFUSED ${ENV.OFFDAY_TOKEN}`);
      return fleet(url, init);
    }, { OFFDAY_TOKEN: ENV.OFFDAY_TOKEN, QRLAB_TOKEN: 'wrong' }, { 'apps.json': APPS });
    const out = JSON.parse(r.output);
    expect(r.code).toBe(1);
    expect(seen.sort()).toEqual(['offday.example', 'qrlab.example']);
    expect(out.apps[0]).toMatchObject({ name: 'leakscan', ok: false, reachable: false, problems: ['LEAKSCAN_TOKEN is not set in this environment'] });
    expect(out.apps[1]).toMatchObject({ name: 'offday', ok: false, reachable: false, problems: ['the app is not reachable at this URL'] });
    expect(out.apps[2].problems[0]).toMatch(/health token was refused/);
    expect(r.output).not.toContain(ENV.OFFDAY_TOKEN);
  });

  it('a bad apps file or bad flags: exit 2 before any request (a scheduled job must not close issues on it)', async () => {
    let calls = 0;
    const fetch: DoctorFetch = async () => (calls++, answer(200, health())());
    const bad: Array<[string, RegExp]> = [
      ['not json', /not valid JSON/],
      ['[]', /non-empty JSON array/],
      ['[{"name":"a","url":"https://a.example/x","tokenEnv":"A","token":"secret-in-file"}]', /never put a token in the file/],
      ['[{"name":"a","url":"http://a.example/x","tokenEnv":"A"}]', /apps\[0\]\.url needs https/],
      ['[{"name":"a","url":"https://a.example/x","tokenEnv":"A"},{"name":"a","url":"https://b.example/x","tokenEnv":"B"}]', /used twice/],
      ['[{"name":"a","url":"https://a.example/x","tokenEnv":"no-dash"}]', /tokenEnv must be/],
      ['[{"name":"a","url":"https://a.example/x","tokenEnv":"A","staleHours":0}]', /staleHours/],
      ['[{"name":"a","url":"https://a.example/x","tokenEnv":"A","extra":1}]', /unknown key/],
    ];
    for (const [file, match] of bad) {
      const r = await run(['--apps', 'f.json'], fetch, { A: 't' }, { 'f.json': file });
      expect([r.code, r.output]).toEqual([2, expect.stringMatching(match)]);
      expect(r.output).not.toContain('secret-in-file');
    }
    expect((await run(['--apps', 'missing.json'], fetch)).code).toBe(2);
    expect((await run(['--apps', 'f.json', '--url', URL_], fetch, {}, { 'f.json': APPS })).code).toBe(2);
    expect((await run(['--apps', 'f.json', '--token', 't'], fetch, {}, { 'f.json': APPS })).code).toBe(2);
    expect(calls).toBe(0);
  });

  it('single-app mode keeps working, and takes --stale-hours and --json too', async () => {
    const stale = await run(['--url', URL_, '--token', TOKEN, '--stale-hours', '2'], answer(200, health()));
    expect(stale.code).toBe(1);
    expect(stale.output).toContain('PROBLEM: no verified event for more than 2 h');
    const json = JSON.parse((await run(['--url', URL_, '--token', TOKEN, '--json'], answer(200, health()))).output);
    expect(json.apps).toHaveLength(1);
    expect(json.apps[0]).toMatchObject({ ok: true, url: URL_, tokenEnv: null });
    expect((await run(['--url', URL_, '--stale-hours', 'soon'], answer(200, health()))).code).toBe(1);
  });

  it('end to end against two real routes: kit health with an app check, and billing off', async () => {
    const viaRoute = (route: { GET(r: Request): Promise<Response> }) => async (url: string, init: { headers: Record<string, string> }) => {
      const res = await route.GET(new Request(url, { headers: init.headers }));
      return { status: res.status, headers: res.headers, text: () => res.text() };
    };
    const billing = createBilling({
      environment: 'sandbox', webhookSecret: 's', store: memoryStore(), entitlements: {}, healthToken: TOKEN, log: () => {},
      healthChecks: { price: async () => ({ ok: false, detail: 'fallback: not_found' }) },
    });
    const on = viaRoute(createWebhookRoute({ billing, problems: [] }));
    const off = viaRoute(createWebhookRoute({ billing: null, problems: [] }));
    const apps = JSON.stringify([{ name: 'on', url: 'https://on.example/api/paddle', tokenEnv: 'T' }, { name: 'off', url: 'https://off.example/api/paddle', tokenEnv: 'T' }]);
    const r = await run(['--apps', 'a.json', '--json'], async (url, init) => (url.includes('//on.') ? on : off)(url, init), { T: TOKEN }, { 'a.json': apps });
    const out = JSON.parse(r.output);
    expect(out.apps[0]).toMatchObject({ billing: 'on', checks: { price: { ok: false, detail: 'fallback: not_found' } }, problems: ['check "price" failed: fallback: not_found'] });
    expect(out.apps[1]).toMatchObject({ billing: 'off', ok: false });
    expect(r.code).toBe(1);
  });
});

