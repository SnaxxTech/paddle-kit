declare const SANDBOX_BASE = "https://sandbox-api.paddle.com";
declare const LIVE_BASE = "https://api.paddle.com";
type FetchLike = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
}) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
}>;
declare class PaddleError extends Error {
    readonly status?: number | undefined;
    name: string;
    /** The HTTP status when Paddle answered with an error; undefined for errors raised before or without a response. */
    constructor(message: string, status?: number | undefined);
}
/** Removes known secret values and anything shaped like a Paddle key/token/secret from text. */
declare function redactSecrets(text: string, known?: readonly string[]): string;

export { LIVE_BASE as L, PaddleError as P, SANDBOX_BASE as S, redactSecrets as r };
export type { FetchLike as F };
