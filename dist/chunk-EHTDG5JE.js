// src/core/paddle-api.ts
var SANDBOX_BASE = "https://sandbox-api.paddle.com";
var LIVE_BASE = "https://api.paddle.com";
var PADDLE_API_VERSION = 1;
var PaddleError = class extends Error {
  /** The HTTP status when Paddle answered with an error; undefined for errors raised before or without a response. */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
  status;
  name = "PaddleError";
};
var TOKEN_SHAPE = /\b(?:pdl_(?:sdbx|live)_[A-Za-z0-9_]+|test_[A-Za-z0-9]{8,}|live_[A-Za-z0-9]{8,}|pdl_ntfset_[A-Za-z0-9_]+)\b/g;
function redactSecrets(text, known = []) {
  let out = text;
  for (const secret of known) if (secret.length >= 6) out = out.split(secret).join("[redacted]");
  return out.replace(TOKEN_SHAPE, "[redacted]");
}
function paddleClient(base, apiKey, fetchImpl, known, signal) {
  async function call(method, apiPath, body) {
    const res = await fetchImpl(base + apiPath, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Paddle-Version": String(PADDLE_API_VERSION) },
      body: body === void 0 ? void 0 : JSON.stringify(body),
      ...signal ? { signal } : {},
      // Never followed (the key would go along): a 3xx, or a browser's opaque redirect (status 0), is not ok and
      // throws below. `manual`, not `error`: Cloudflare Workers rejects the "error" redirect mode (since v0.8.7).
      redirect: "manual"
    });
    let parsed = {};
    try {
      parsed = await res.json();
    } catch {
      parsed = {};
    }
    if (!res.ok) {
      const err = parsed?.error ?? {};
      throw new PaddleError(
        redactSecrets(`${method} ${apiPath} failed: ${res.status} ${String(err.code ?? "unknown_error")}: ${String(err.detail ?? "no detail")}`, known),
        res.status
      );
    }
    return parsed;
  }
  async function page(apiPath) {
    const res = await call("GET", apiPath);
    if (!Array.isArray(res.data)) throw new PaddleError("pagination response has no data array");
    const pagination = res.meta?.pagination;
    if (!pagination?.has_more) return { data: res.data, next: null };
    if (!pagination.next) throw new PaddleError("pagination response has_more without a next page");
    const u = new URL(String(pagination.next), base);
    if (u.origin !== new URL(base).origin || u.protocol !== "https:") throw new PaddleError("pagination link points to another host");
    return { data: res.data, next: u.pathname + u.search };
  }
  async function list(apiPath, maxPages = 50) {
    const items = [];
    let next = apiPath;
    for (let n = 0; next && n < maxPages; n++) {
      const res = await page(next);
      items.push(...res.data);
      next = res.next;
    }
    if (next) throw new PaddleError("pagination limit reached: result is incomplete");
    return items;
  }
  return { call, list, page };
}

export {
  SANDBOX_BASE,
  LIVE_BASE,
  PADDLE_API_VERSION,
  PaddleError,
  redactSecrets,
  paddleClient
};
