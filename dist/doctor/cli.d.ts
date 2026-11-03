#!/usr/bin/env node
declare const USAGE = "Usage: paddle-kit-doctor --url <health route URL> [--token <token>]\n       paddle-kit-doctor --apps <apps.json> [--json] [--html <file>]\n\n  --url <url>          the app's webhook route, e.g. https://app.example.com/api/paddle (https; http only for localhost)\n  --token <token>      the app's PADDLE_HEALTH_TOKEN (default: the PADDLE_HEALTH_TOKEN environment variable)\n  --stale-hours <h>    a problem when no verified event arrived for this long\n  --apps <file>        check several apps: a JSON array of { \"name\", \"url\", \"tokenEnv\", \"staleHours\"? }. Each token\n                       is read from the environment variable that tokenEnv names, never from the file.\n  --json               print one JSON result (for a scheduled job), not the table\n  --html <file>        also write a self-contained status page (one card per app) to <file>\n  --timeout <ms>       give up on an app after this long (default: 10000)\n  --help               show this text\n";
type DoctorFetch = (url: string, init: {
    headers: Record<string, string>;
    redirect: 'manual';
    signal: AbortSignal;
}) => Promise<{
    status: number;
    headers: {
        get(name: string): string | null;
    };
    text(): Promise<string>;
}>;
interface Diagnosis {
    ok: boolean;
    lines: string[];
}
/** Turns one health-route answer into plain lines. `body` is the raw text; it is parsed here. */
declare function diagnose(status: number, body: string, opts?: {
    now?: number;
    sentToken?: boolean;
    staleHours?: number;
    recoveryStaleHours?: number;
}): Diagnosis;
/** One app's result, as `--json` prints it. Never holds the token, only the name of its variable. */
interface AppResult {
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
    checks: Record<string, {
        ok: boolean;
        detail?: string;
    }>;
    /** Why it is red, in plain words; empty when ok. */
    problems: string[];
    /** The single-app report, line by line. */
    lines: string[];
}
interface Target {
    name: string;
    url: URL;
    token: string | undefined;
    tokenEnv: string | null;
    staleHours?: number;
}
declare function checkApp(t: Target, deps: {
    fetch: DoctorFetch;
    timeoutMs: number;
    now: number;
}): Promise<AppResult>;
/** Reads and checks an apps file. Tokens never go in it: an entry with a `token` key is refused. */
declare function readApps(text: string, env: Record<string, string | undefined>): Target[];
/**
 * One self-contained HTML page: a summary strip, then a card per app, red first. Every value is escaped (problems and
 * check details come from the apps). No script, no external file, no token: safe to publish behind a login.
 * Light and dark follow the viewer; status is shown by icon and words, never by colour alone.
 */
declare function renderDashboard(results: AppResult[], now: number): string;
interface DoctorArgs {
    url?: string;
    token?: string;
    apps?: string;
    json?: boolean;
    html?: string;
    staleHours?: number;
    timeoutMs: number;
    help: boolean;
}
declare function parseArgs(argv: string[]): DoctorArgs;
declare function main(argv?: string[], deps?: {
    fetch?: DoctorFetch;
    env?: Record<string, string | undefined>;
    now?: number;
    readFile?: (file: string) => string;
}): Promise<number>;

export { USAGE, checkApp, diagnose, main, parseArgs, readApps, renderDashboard };
export type { AppResult, Diagnosis, DoctorArgs, DoctorFetch, Target };
