#!/usr/bin/env node
// paddle-kit-doctor --url https://app.example.com/api/paddle [--token <PADDLE_HEALTH_TOKEN>]
// Calls a deployed app's health route (GET, Authorization: Bearer) and says in plain words what is wrong.
// Exit 0: no problem (warnings allowed). Exit 1: a problem, or a usage error. Never prints the token.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Health } from '../core/types';

export const USAGE = `Usage: paddle-kit-doctor --url <health route URL> [--token <token>]

  --url <url>        the app's webhook route, e.g. https://app.example.com/api/paddle (https; http only for localhost)
  --token <token>    the app's PADDLE_HEALTH_TOKEN (default: the PADDLE_HEALTH_TOKEN environment variable)
  --timeout <ms>     give up after this long (default: 10000)
  --help             show this text
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
  store_error: 'the database failed (down, or a migration not run)',
  hook_error: "the app's onTransaction / onAdjustment hook threw",
  bad_signature_header: 'a request had no valid Paddle-Signature header (often a bot, not Paddle)',
  missing_body: 'a request had no body (often a bot, not Paddle)',
  bad_json: 'a signed body was not JSON',
  bad_payload: 'a signed event missed fields the kit needs',
  body_too_large: 'a request body was over the size cap',
};
// A recent failure with one of these reasons is a problem; the others are usually bots on a public URL.
const SETUP_FAILURES = ['signature_mismatch', 'store_error', 'hook_error'];

function ago(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const m = Math.round(ms / 60_000);
  const span = m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
  return `${iso} (${span} ago)`;
}

export interface Diagnosis {
  ok: boolean;
  lines: string[];
}

/** Turns one health-route answer into plain lines. `body` is the raw text; it is parsed here. */
export function diagnose(status: number, body: string, opts: { now?: number; sentToken?: boolean } = {}): Diagnosis {
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

  const h = data as Health & { kitVersion?: string; environment?: string };
  const lines = ['Reachable: yes', `Billing: on${h.environment ? ` (${h.environment})` : ''}${h.kitVersion ? `, paddle-kit ${h.kitVersion}` : ''}`];
  const problems: string[] = [];
  lines.push(`Last event: ${h.lastEventAt ? ago(h.lastEventAt, now) : 'none yet (normal right after the first deploy; send a simulator event)'}`);
  if (h.lastFailureReason) {
    const words = REASONS[h.lastFailureReason];
    lines.push(`Last failure: ${h.lastFailureReason}${words ? `: ${words}` : ''}${h.lastFailureAt ? `, at ${ago(h.lastFailureAt, now)}` : ''}`);
    const recent = h.lastFailureAt !== null && now - Date.parse(h.lastFailureAt) < 24 * 3600_000;
    if (recent && SETUP_FAILURES.includes(h.lastFailureReason)) problems.push(`${h.lastFailureReason} in the last 24 h: ${words}`);
  } else {
    lines.push('Last failure: none');
  }
  lines.push(`Failed in the last 24 h: ${h.failedLast24h}${h.failedLast24h > 0 ? ' (bots on a public URL count too)' : ''}`);
  if (h.unlinkedLast24h > 0) lines.push(`WARNING: ${h.unlinkedLast24h} subscription event(s) without a userId in 24 h: open each checkout with createCheckout`);
  return { ok: problems.length === 0, lines: [...lines, ...problems.map((p) => `PROBLEM: ${p}`)] };
}

export interface DoctorArgs {
  url?: string;
  token?: string;
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
    else if (a === '--timeout') {
      args.timeoutMs = Number(value(i++, a));
      if (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 1) throw new Error('--timeout needs a whole number of milliseconds');
    } else throw new Error(`unknown option: ${a}`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2), deps: { fetch?: DoctorFetch; env?: Record<string, string | undefined>; now?: number } = {}): Promise<number> {
  const out = (line: string) => console.log(line);
  let args: DoctorArgs;
  let url: URL;
  try {
    args = parseArgs(argv);
    if (args.help) {
      out(USAGE);
      return 0;
    }
    if (!args.url) throw new Error('--url is required');
    url = new URL(args.url);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('--url needs https (http only for localhost): the token travels in the request');
  } catch (error) {
    console.error(`paddle-kit-doctor: ${error instanceof TypeError ? '--url is not a URL' : (error as Error).message}`);
    return 1;
  }
  const token = args.token ?? (deps.env ?? process.env).PADDLE_HEALTH_TOKEN;
  if (!token) out('Note: no token (--token or PADDLE_HEALTH_TOKEN): the route can only say whether billing is on.');

  const fetchImpl: DoctorFetch = deps.fetch ?? ((u, init) => fetch(u, init));
  let res: Awaited<ReturnType<DoctorFetch>>;
  let body: string;
  out(`Checking ${url.origin}${url.pathname}`);
  try {
    const signal = AbortSignal.timeout(args.timeoutMs);
    // Manual redirects: a followed redirect could carry the token to another host.
    res = await fetchImpl(url.href, { headers: token ? { authorization: `Bearer ${token}` } : {}, redirect: 'manual', signal });
    body = await res.text();
  } catch (error) {
    const timedOut = (error as Error)?.name === 'TimeoutError';
    out(`Reachable: no (${timedOut ? `no answer in ${args.timeoutMs} ms` : 'DNS, TLS or connection failure'})`);
    out('PROBLEM: the app is not reachable at this URL');
    return 1;
  }
  if (res.status >= 300 && res.status < 400) {
    out('Reachable: yes');
    out(`PROBLEM: HTTP ${res.status} redirect${res.headers.get('location') ? ` to ${res.headers.get('location')}` : ''}. Use the final URL here and in the Paddle notification destination.`);
    return 1;
  }
  const result = diagnose(res.status, body, { now: deps.now, sentToken: !!token });
  for (const line of result.lines) out(line);
  out(result.ok ? 'Result: OK' : 'Result: PROBLEM (exit 1)');
  return result.ok ? 0 : 1;
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
