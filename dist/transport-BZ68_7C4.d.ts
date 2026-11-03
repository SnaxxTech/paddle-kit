import { F as FetchLike } from './billing-BOxBWFZG.js';

type TransportErrorCode = 'timeout' | 'aborted' | 'network' | 'circuit_open' | 'invalid_response';
/** Messages contain no URL, credentials, provider body, or underlying network error. */
declare class PaddleTransportError extends Error {
    readonly code: TransportErrorCode;
    readonly retryAt: number | null;
    name: string;
    constructor(code: TransportErrorCode, retryAt?: number | null);
}
interface CircuitState {
    state: 'closed' | 'open' | 'half_open';
    consecutiveFailures: number;
    retryAt: string | null;
}
interface TransportOptions {
    fetch?: FetchLike;
    /** A complete attempt, including the JSON body. Default 4000. */
    requestTimeoutMs?: number;
    /** Includes retries and backoff. Default 10000. */
    budgetMs?: number;
    /** GET only. Mutations are never retried automatically. Default 2. */
    maxRetries?: number;
    failureThreshold?: number;
    cooldownMs?: number;
}
interface PaddleTransport {
    fetch: FetchLike;
    state(): CircuitState;
}
/**
 * One transport per app/account/environment, reused by pricing and reconciliation. The breaker is local to this
 * instance: it protects a warm process, not an entire serverless fleet. After cooling down exactly one call probes
 * Paddle; a successful probe closes it. It never affects incoming webhooks or local entitlement reads.
 */
declare function createPaddleTransport(opts?: TransportOptions): PaddleTransport;

export { PaddleTransportError as a, createPaddleTransport as c };
export type { CircuitState as C, PaddleTransport as P, TransportOptions as T };
