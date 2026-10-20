// src/core/paddle-api.ts
var SANDBOX_BASE = "https://sandbox-api.paddle.com";
var LIVE_BASE = "https://api.paddle.com";
var PADDLE_API_VERSION = 1;
var PaddleError = class extends Error {
  name = "PaddleError";
};
var TOKEN_SHAPE = /\b(?:pdl_(?:sdbx|live)_[A-Za-z0-9_]+|test_[A-Za-z0-9]{8,}|live_[A-Za-z0-9]{8,}|pdl_ntfset_[A-Za-z0-9_]+)\b/g;
function redactSecrets(text, known = []) {
  let out = text;
  for (const secret of known) if (secret.length >= 6) out = out.split(secret).join("[redacted]");
  return out.replace(TOKEN_SHAPE, "[redacted]");
}
function paddleClient(base, apiKey, fetchImpl, known) {
  async function call(method, apiPath, body) {
    const res = await fetchImpl(base + apiPath, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Paddle-Version": String(PADDLE_API_VERSION) },
      body: body === void 0 ? void 0 : JSON.stringify(body)
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
        redactSecrets(`${method} ${apiPath} failed: ${res.status} ${String(err.code ?? "unknown_error")}: ${String(err.detail ?? "no detail")}`, known)
      );
    }
    return parsed;
  }
  async function list(apiPath, maxPages = 50) {
    const items = [];
    let next = apiPath;
    for (let page = 0; next && page < maxPages; page++) {
      const res = await call("GET", next);
      items.push(...res.data ?? []);
      const pagination = res.meta?.pagination;
      next = null;
      if (pagination?.has_more && pagination.next) {
        const u = new URL(String(pagination.next), base);
        if (u.origin !== new URL(base).origin || u.protocol !== "https:") throw new PaddleError("pagination link points to another host");
        next = u.pathname + u.search;
      }
    }
    return items;
  }
  return { call, list };
}

export {
  SANDBOX_BASE,
  LIVE_BASE,
  PADDLE_API_VERSION,
  PaddleError,
  redactSecrets,
  paddleClient
};
