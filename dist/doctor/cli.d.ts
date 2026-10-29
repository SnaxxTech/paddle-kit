#!/usr/bin/env node
declare const USAGE = "Usage: paddle-kit-doctor --url <health route URL> [--token <token>]\n\n  --url <url>        the app's webhook route, e.g. https://app.example.com/api/paddle (https; http only for localhost)\n  --token <token>    the app's PADDLE_HEALTH_TOKEN (default: the PADDLE_HEALTH_TOKEN environment variable)\n  --timeout <ms>     give up after this long (default: 10000)\n  --help             show this text\n";
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
}): Diagnosis;
interface DoctorArgs {
    url?: string;
    token?: string;
    timeoutMs: number;
    help: boolean;
}
declare function parseArgs(argv: string[]): DoctorArgs;
declare function main(argv?: string[], deps?: {
    fetch?: DoctorFetch;
    env?: Record<string, string | undefined>;
    now?: number;
}): Promise<number>;

export { USAGE, diagnose, main, parseArgs };
export type { Diagnosis, DoctorArgs, DoctorFetch };
