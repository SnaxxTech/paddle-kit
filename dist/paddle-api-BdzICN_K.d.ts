declare const SANDBOX_BASE = "https://sandbox-api.paddle.com";
declare const LIVE_BASE = "https://api.paddle.com";
type FetchLike = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
}) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
}>;
declare class PaddleError extends Error {
    name: string;
}
/** Removes known secret values and anything shaped like a Paddle key/token/secret from text. */
declare function redactSecrets(text: string, known?: readonly string[]): string;

export { type FetchLike as F, LIVE_BASE as L, PaddleError as P, SANDBOX_BASE as S, redactSecrets as r };
