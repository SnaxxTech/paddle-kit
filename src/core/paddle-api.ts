// Minimal Paddle REST client shared by the catalog CLI and reconcile. Web fetch only (edge-safe).
// Never puts the API key in an error: messages pass through redactSecrets.

export const SANDBOX_BASE = 'https://sandbox-api.paddle.com';
export const LIVE_BASE = 'https://api.paddle.com';
/** The Paddle API version the kit's parsers are written for. Sent on every request and set on the webhook destination. */
export const PADDLE_API_VERSION = 1;

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class PaddleError extends Error {
  override name = 'PaddleError';
  /** The HTTP status when Paddle answered with an error; undefined for errors raised before or without a response. */
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

// ---------- redaction ----------

const TOKEN_SHAPE = /\b(?:pdl_(?:sdbx|live)_[A-Za-z0-9_]+|test_[A-Za-z0-9]{8,}|live_[A-Za-z0-9]{8,}|pdl_ntfset_[A-Za-z0-9_]+)\b/g;

/** Removes known secret values and anything shaped like a Paddle key/token/secret from text. */
export function redactSecrets(text: string, known: readonly string[] = []): string {
  let out = text;
  for (const secret of known) if (secret.length >= 6) out = out.split(secret).join('[redacted]');
  return out.replace(TOKEN_SHAPE, '[redacted]');
}

export type Json = Record<string, any>;

export function paddleClient(base: string, apiKey: string, fetchImpl: FetchLike, known: string[], signal?: AbortSignal) {
  async function call(method: string, apiPath: string, body?: unknown): Promise<Json> {
    const res = await fetchImpl(base + apiPath, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Paddle-Version': String(PADDLE_API_VERSION) },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    let parsed: Json = {};
    try {
      parsed = (await res.json()) as Json;
    } catch {
      parsed = {};
    }
    if (!res.ok) {
      const err = parsed?.error ?? {};
      throw new PaddleError(
        redactSecrets(`${method} ${apiPath} failed: ${res.status} ${String(err.code ?? 'unknown_error')}: ${String(err.detail ?? 'no detail')}`, known),
        res.status,
      );
    }
    return parsed;
  }
  // Follows meta.pagination.next while has_more; never follows a link to another host (the key would leak).
  async function list(apiPath: string, maxPages = 50): Promise<Json[]> {
    const items: Json[] = [];
    let next: string | null = apiPath;
    for (let page = 0; next && page < maxPages; page++) {
      const res: Json = await call('GET', next);
      items.push(...((res.data as Json[]) ?? []));
      const pagination = res.meta?.pagination;
      next = null;
      if (pagination?.has_more && pagination.next) {
        const u = new URL(String(pagination.next), base);
        if (u.origin !== new URL(base).origin || u.protocol !== 'https:') throw new PaddleError('pagination link points to another host');
        next = u.pathname + u.search;
      }
    }
    return items;
  }
  return { call, list };
}
