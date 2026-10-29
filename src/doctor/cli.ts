#!/usr/bin/env node
// paddle-kit-doctor --url https://app.example.com/api/paddle [--token <PADDLE_HEALTH_TOKEN>]
// paddle-kit-doctor --apps apps.json [--json]
// Calls deployed apps' health routes (GET, Authorization: Bearer) and says in plain words what is wrong.
// Exit 0: no problem (warnings allowed). Exit 1: a problem (single-app mode: also a usage error). Exit 2: with --apps,
// the file or the flags are wrong and nothing was checked. Never prints a token.
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HealthReport } from '../core/types';

export const USAGE = `Usage: paddle-kit-doctor --url <health route URL> [--token <token>]
       paddle-kit-doctor --apps <apps.json> [--json]

  --url <url>          the app's webhook route, e.g. https://app.example.com/api/paddle (https; http only for localhost)
  --token <token>      the app's PADDLE_HEALTH_TOKEN (default: the PADDLE_HEALTH_TOKEN environment variable)
  --stale-hours <h>    a problem when no verified event arrived for this long
  --apps <file>        check several apps: a JSON array of { "name", "url", "tokenEnv", "staleHours"? }. Each token
                       is read from the environment variable that tokenEnv names, never from the file.
  --json               print one JSON result (for a scheduled job), not the table
  --timeout <ms>       give up on an app after this long (default: 10000)
  --help               show this text
`;

export type DoctorFetch = (url: string, init: { headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

// Plain words for the failure reasons that point at the app's setup (README, Monitoring).
const REASONS: Record<string, string> = {
  signature_mismatch: 'the webhook secret on the host does not match the Paddle notification destination',
  stale_timestamp: 'an event arrived more than 5 s after Paddle signed it (slow cold start, or a wrong clock)',
  future_timestamp: "an event was signed in the future: the host's clock is behind",
  store_error: 'the database failed (down, or a migration not run)',
  hook_error: "the app's onTransaction / onAdjustment hook threw",
  prices_unavailable: 'the app could not find its price ids in Paddle (PADDLE_API_KEY, a missing price label, or Paddle down); Paddle retries',
  bad_signature_header: 'a request had no valid Paddle-Signature header (often a bot, not Paddle)',
  missing_body: 'a request had no body (often a bot, not Paddle)',
  bad_json: 'a signed body was not JSON',
  bad_payload: 'a signed event missed fields the kit needs',
  body_too_large: 'a request body was over the size cap',
};
// A recent failure with one of these reasons is a problem; the others are usually bots on a public URL.
const SETUP_FAILURES = ['signature_mismatch', 'store_error', 'hook_error', 'prices_unavailable'];
const HOUR = 3600_000;

function span(iso: string, now: number): string | null {
  const ms = now - Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
}
const ago = (iso: string, now: number) => (span(iso, now) === null ? iso : `${iso} (${span(iso, now)} ago)`);

export interface Diagnosis {
  ok: boolean;
  lines: string[];
}

/** Turns one health-route answer into plain lines. `body` is the raw text; it is parsed here. */
export function diagnose(status: number, body: string, opts: { now?: number; sentToken?: boolean; staleHours?: number } = {}): Diagnosis {
  const now = opts.now ?? Date.now();
  let data: any = null;
  try {
    data = body ? JSON.parse(body) : null;
  } catch {
    data = null;
  }
  const fail = (...lines: string[]): Diagnosis => ({ ok: false, lines: ['Reachable: yes', ...lines.map((l) => `PROBLEM: ${l}`)] });

  if (status === 401 && opts.sentToken === false) return fail('the health route needs a token: pass --token (the PADDLE_HEALTH_TOKEN of the host)');
  if (status === 401) return fail('the health token was refused: --token differs from PADDLE_HEALTH_TOKEN on the host');
  if (status === 404 && data?.error === 'billing_off')
    return fail('billing is OFF on this deployment: no billing variable is set on the host. Add them (paddle-kit-catalog prints the list) and redeploy.');
  if (status === 404 && data?.error === 'health_off') return fail('billing is on, but the health route is off: set PADDLE_HEALTH_TOKEN on the host and redeploy.');
  if (status === 404) return fail('404: no paddle-kit route at this URL, or (kit before 0.6.0) billing is off or PADDLE_HEALTH_TOKEN is not set.');
  if (status === 503 && data?.error === 'misconfigured' && Array.isArray(data.problems))
    return fail('billing is misconfigured on the host:', ...data.problems.map((p: unknown) => `  ${String(p)}`));
  if (status === 503 && data?.error === 'store_error') return fail('the database is not reachable from the app (health answered store_error).');
  if (status === 503)
    return fail('billing is misconfigured on the host (503). To see the variable names, pass healthToken to createWebhookRoute and use the same token here.');
  if (status !== 200 || !data || typeof data !== 'object' || !('lastEventAt' in data)) return fail(`unexpected answer: HTTP ${status}, not a paddle-kit health report`);

  const h = data as Partial<HealthReport> & Pick<HealthReport, 'lastEventAt' | 'lastFailureAt' | 'lastFailureReason' | 'failedLast24h' | 'unlinkedLast24h'>;
  const lines = ['Reachable: yes', `Billing: on${h.environment ? ` (${h.environment})` : ''}${h.kitVersion ? `, paddle-kit ${h.kitVersion}` : ''}`];
  const problems: string[] = [];
  lines.push(`Last event: ${h.lastEventAt ? ago(h.lastEventAt, now) : 'none yet (normal right after the first deploy; send a simulator event)'}`);
  if (opts.staleHours !== undefined && (!h.lastEventAt || now - Date.parse(h.lastEventAt) > opts.staleHours * HOUR)) {
    problems.push(`no verified event for more than ${opts.staleHours} h: check the webhook secret and the Paddle notification destination`);
  }
  if (h.lastFailureReason) {
    const words = REASONS[h.lastFailureReason];
    lines.push(`Last failure: ${h.lastFailureReason}${words ? `: ${words}` : ''}${h.lastFailureAt ? `, at ${ago(h.lastFailureAt, now)}` : ''}`);
    const recent = h.lastFailureAt !== null && now - Date.parse(h.lastFailureAt) < 24 * HOUR;
    if (recent && SETUP_FAILURES.includes(h.lastFailureReason)) problems.push(`${h.lastFailureReason} in the last 24 h: ${words}`);
  } else {
    lines.push('Last failure: none');
  }
  lines.push(`Failed in the last 24 h: ${h.failedLast24h}${h.failedLast24h > 0 ? ' (bots on a public URL count too)' : ''}`);
  if (h.unlinkedLast24h > 0) lines.push(`WARNING: ${h.unlinkedLast24h} subscription event(s) without a userId in 24 h: open each checkout with createCheckout`);
  const u = h.unverified;
  if (u && u.count > 0) {
    const reasons = Object.entries(u.byReason).map(([r, n]) => `${r} ${n}`).join(', ');
    lines.push(`Refused before the signature check: ${u.count} since ${u.since}, on the server instance that answered (${reasons})`);
    if (u.byReason.signature_mismatch)
      lines.push('WARNING: signature_mismatch: a request was signed with another secret. If Paddle sent it, the host has the wrong secret (no new verified event confirms it).');
  }
  for (const [name, c] of Object.entries(h.checks ?? {})) {
    if (c.ok) lines.push(`Check ${name}: ok${c.detail ? ` (${c.detail})` : ''}`);
    else problems.push(`check "${name}" failed${c.detail ? `: ${c.detail}` : ''}`);
  }
  return { ok: problems.length === 0, lines: [...lines, ...problems.map((p) => `PROBLEM: ${p}`)] };
}

/** One app's result, as `--json` prints it. Never holds the token, only the name of its variable. */
export interface AppResult {
  name: string;
  url: string;
  tokenEnv: string | null;
  ok: boolean;
  reachable: boolean;
  httpStatus: number | null;
  billing: 'on' | 'off' | 'health_off' | 'misconfigured' | null;
  environment: string | null;
  kitVersion: string | null;
  /** Variable problems the route listed (names only). */
  envProblems: string[];
  lastEventAt: string | null;
  lastEventAgeHours: number | null;
  staleHours: number | null;
  stale: boolean | null;
  lastOwnedAt: string | null;
  failedLast24h: number | null;
  lastFailureReason: string | null;
  lastFailureAt: string | null;
  unverifiedCount: number | null;
  checks: Record<string, { ok: boolean; detail?: string }>;
  /** Why it is red, in plain words; empty when ok. */
  problems: string[];
  /** The single-app report, line by line. */
  lines: string[];
}

export interface Target {
  name: string;
  url: URL;
  token: string | undefined;
  tokenEnv: string | null;
  staleHours?: number;
}

/** Calls one health route and diagnoses the answer. Never follows a redirect (a followed redirect could carry the token). */
function finish(result: AppResult, lines: string[]): AppResult {
  result.lines = lines;
  result.problems = lines.filter((l) => l.startsWith('PROBLEM: ')).map((l) => l.slice('PROBLEM: '.length));
  result.ok = result.problems.length === 0;
  return result;
}

function blank(t: Target): AppResult {
  return {
    name: t.name, url: `${t.url.origin}${t.url.pathname}`, tokenEnv: t.tokenEnv, ok: false, reachable: false, httpStatus: null, billing: null,
    environment: null, kitVersion: null, envProblems: [], lastEventAt: null, lastEventAgeHours: null, staleHours: t.staleHours ?? null,
    stale: null, lastOwnedAt: null, failedLast24h: null, lastFailureReason: null, lastFailureAt: null, unverifiedCount: null, checks: {},
    problems: [], lines: [],
  };
}

export async function checkApp(t: Target, deps: { fetch: DoctorFetch; timeoutMs: number; now: number }): Promise<AppResult> {
  const result = blank(t);
  const done = (lines: string[]) => finish(result, lines);
  let res: Awaited<ReturnType<DoctorFetch>>;
  let body: string;
  try {
    const signal = AbortSignal.timeout(deps.timeoutMs);
    res = await deps.fetch(t.url.href, { headers: t.token ? { authorization: `Bearer ${t.token}` } : {}, redirect: 'manual', signal });
    body = await res.text();
  } catch (error) {
    const timedOut = (error as Error)?.name === 'TimeoutError';
    return done([`Reachable: no (${timedOut ? `no answer in ${deps.timeoutMs} ms` : 'DNS, TLS or connection failure'})`, 'PROBLEM: the app is not reachable at this URL']);
  }
  result.reachable = true;
  result.httpStatus = res.status;
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    return done(['Reachable: yes', `PROBLEM: HTTP ${res.status} redirect${location ? ` to ${location}` : ''}. Use the final URL here and in the Paddle notification destination.`]);
  }
  let data: any = null;
  try {
    data = JSON.parse(body);
  } catch {
    data = null;
  }
  if (res.status === 404 && (data?.error === 'billing_off' || data?.error === 'health_off')) result.billing = data.error === 'billing_off' ? 'off' : 'health_off';
  if (res.status === 503 && data?.error === 'misconfigured') {
    result.billing = 'misconfigured';
    if (Array.isArray(data.problems)) result.envProblems = data.problems.map(String);
  }
  if (res.status === 200 && data && typeof data === 'object' && 'lastEventAt' in data) {
    const h = data as Partial<HealthReport>;
    result.billing = 'on';
    result.environment = h.environment ?? null;
    result.kitVersion = h.kitVersion ?? null;
    result.lastEventAt = h.lastEventAt ?? null;
    if (h.lastEventAt && !Number.isNaN(Date.parse(h.lastEventAt))) result.lastEventAgeHours = Math.round(((deps.now - Date.parse(h.lastEventAt)) / HOUR) * 10) / 10;
    if (t.staleHours !== undefined) result.stale = result.lastEventAgeHours === null || result.lastEventAgeHours > t.staleHours;
    result.lastOwnedAt = h.lastOwnedAt ?? null;
    result.failedLast24h = h.failedLast24h ?? null;
    result.lastFailureReason = h.lastFailureReason ?? null;
    result.lastFailureAt = h.lastFailureAt ?? null;
    result.unverifiedCount = h.unverified?.count ?? null;
    result.checks = h.checks ?? {};
  }
  return done(diagnose(res.status, body, { now: deps.now, sentToken: !!t.token, staleHours: t.staleHours }).lines);
}

const HTTPS_ONLY = '--url needs https (http only for localhost): the token travels in the request';
function checkUrl(raw: unknown, where: string): URL {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error(`${where} is not a URL`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error(where === '--url' ? HTTPS_ONLY : `${where} needs https (http only for localhost)`);
  return url;
}

/** Reads and checks an apps file. Tokens never go in it: an entry with a `token` key is refused. */
export function readApps(text: string, env: Record<string, string | undefined>): Target[] {
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    throw new Error('the apps file is not valid JSON');
  }
  if (!Array.isArray(list) || list.length === 0) throw new Error('the apps file must be a non-empty JSON array of { name, url, tokenEnv, staleHours? }');
  const names = new Set<string>();
  return list.map((a: any, i: number) => {
    const at = `apps[${i}]`;
    if (typeof a !== 'object' || a === null || Array.isArray(a)) throw new Error(`${at} must be an object`);
    for (const k of Object.keys(a)) {
      if (k === 'token') throw new Error(`${at}.token: never put a token in the file; name its environment variable in tokenEnv`);
      if (!['name', 'url', 'tokenEnv', 'staleHours'].includes(k)) throw new Error(`${at}.${k}: unknown key (allowed: name, url, tokenEnv, staleHours)`);
    }
    if (typeof a.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(a.name)) throw new Error(`${at}.name must be an identifier (letters, digits, . _ -)`);
    if (names.has(a.name)) throw new Error(`${at}.name "${a.name}" is used twice`);
    names.add(a.name);
    if (typeof a.tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(a.tokenEnv)) throw new Error(`${at}.tokenEnv must be an environment variable name`);
    if (a.staleHours !== undefined && (typeof a.staleHours !== 'number' || !(a.staleHours > 0))) throw new Error(`${at}.staleHours must be a number of hours above 0`);
    return { name: a.name, url: checkUrl(a.url, `${at}.url`), token: env[a.tokenEnv] || undefined, tokenEnv: a.tokenEnv, staleHours: a.staleHours };
  });
}

function table(results: AppResult[], now: number): string[] {
  const rows = [['APP', 'RESULT', 'REACHABLE', 'ENV', 'LAST EVENT', 'FAILED 24H', 'CHECKS']];
  for (const r of results) {
    const env = r.billing === 'misconfigured' ? `${r.envProblems.length || '?'} problem(s)` : r.billing === null ? '-' : r.billing === 'on' ? 'ok' : r.billing;
    const last = r.billing !== 'on' ? '-' : r.lastEventAt ? `${span(r.lastEventAt, now) ?? '?'} ago` : 'none';
    const stale = r.stale ? ` STALE (>${r.staleHours} h)` : '';
    const failed = r.failedLast24h === null ? '-' : `${r.failedLast24h}${r.lastFailureReason ? ` (last: ${r.lastFailureReason})` : ''}`;
    const checks = Object.entries(r.checks).map(([n, c]) => `${n} ${c.ok ? 'ok' : 'FAIL'}`).join(', ') || '-';
    rows.push([r.name, r.ok ? 'OK' : 'PROBLEM', r.reachable ? 'yes' : 'no', env, last + stale, failed, checks]);
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd());
}

export interface DoctorArgs {
  url?: string;
  token?: string;
  apps?: string;
  json?: boolean;
  staleHours?: number;
  timeoutMs: number;
  help: boolean;
}

export function parseArgs(argv: string[]): DoctorArgs {
  const args: DoctorArgs = { timeoutMs: 10_000, help: false };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--url') args.url = value(i++, a);
    else if (a === '--token') args.token = value(i++, a);
    else if (a === '--apps') args.apps = value(i++, a);
    else if (a === '--json') args.json = true;
    else if (a === '--stale-hours') {
      args.staleHours = Number(value(i++, a));
      if (!(args.staleHours > 0)) throw new Error('--stale-hours needs a number of hours above 0');
    } else if (a === '--timeout') {
      args.timeoutMs = Number(value(i++, a));
      if (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 1) throw new Error('--timeout needs a whole number of milliseconds');
    } else throw new Error(`unknown option: ${a}`);
  }
  if (args.apps !== undefined && (args.url !== undefined || args.token !== undefined || args.staleHours !== undefined))
    throw new Error('--apps takes no --url, --token or --stale-hours: each app has its own in the file');
  return args;
}

export async function main(
  argv = process.argv.slice(2),
  deps: { fetch?: DoctorFetch; env?: Record<string, string | undefined>; now?: number; readFile?: (file: string) => string } = {},
): Promise<number> {
  const out = (line: string) => console.log(line);
  const env = deps.env ?? process.env;
  const multi = argv.includes('--apps');
  let args: DoctorArgs;
  let targets: Target[];
  try {
    args = parseArgs(argv);
    if (args.help) {
      out(USAGE);
      return 0;
    }
    if (args.apps !== undefined) {
      let text: string;
      try {
        text = (deps.readFile ?? ((f) => readFileSync(path.resolve(f), 'utf8')))(args.apps);
      } catch {
        throw new Error(`cannot read the apps file ${args.apps}`);
      }
      targets = readApps(text, env);
    } else {
      if (!args.url) throw new Error('--url is required (or --apps)');
      const token = args.token ?? env.PADDLE_HEALTH_TOKEN;
      targets = [{ name: 'app', url: checkUrl(args.url, '--url'), token, tokenEnv: args.token ? null : 'PADDLE_HEALTH_TOKEN', staleHours: args.staleHours }];
    }
  } catch (error) {
    console.error(`paddle-kit-doctor: ${(error as Error).message}`);
    return multi ? 2 : 1;
  }
  const now = deps.now ?? Date.now();
  const fetchImpl: DoctorFetch = deps.fetch ?? ((u, init) => fetch(u, init));
  const check = { fetch: fetchImpl, timeoutMs: args.timeoutMs, now };

  if (args.apps === undefined && !args.json) {
    const t = targets[0]!;
    if (!t.token) out('Note: no token (--token or PADDLE_HEALTH_TOKEN): the route can only say whether billing is on.');
    out(`Checking ${t.url.origin}${t.url.pathname}`);
    const r = await checkApp(t, check);
    for (const line of r.lines) out(line);
    out(r.ok ? 'Result: OK' : 'Result: PROBLEM (exit 1)');
    return r.ok ? 0 : 1;
  }

  // No request for an app whose token is not set: the answer could only be a 401.
  const results = await Promise.all(
    targets.map((t) => (t.token || t.tokenEnv === null ? checkApp(t, check) : finish(blank(t), [`PROBLEM: ${t.tokenEnv} is not set in this environment`]))),
  );
  const ok = results.every((r) => r.ok);
  if (args.json) {
    out(JSON.stringify({ ok, checkedAt: new Date(now).toISOString(), apps: results.map(({ lines: _lines, ...r }) => r) }, null, 2));
  } else {
    for (const line of table(results, now)) out(line);
    for (const r of results) for (const p of r.problems) out(`${r.name}: PROBLEM: ${p}`);
    const red = results.filter((r) => !r.ok).map((r) => r.name);
    out(ok ? `Result: OK (${results.length} app${results.length === 1 ? '' : 's'})` : `Result: PROBLEM in ${red.join(', ')} (exit 1)`);
  }
  return ok ? 0 : 1;
}

// Run only as the executable (also through the npm bin symlink), never when imported by tests.
const isEntry = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isEntry) process.exitCode = await main();
