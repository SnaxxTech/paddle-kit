// src/express/index.ts
function toHeaders(req) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  return headers;
}
async function forward(response, res) {
  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.send(await response.text());
}
function fail(billing, res) {
  try {
    billing.log({ level: "error", reason: "store_error" });
  } catch {
  }
  if (!res.headersSent) res.status(500).json({ error: "store_error" });
}
function paddleWebhook(billing) {
  return async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) {
        await billing.recordFailure("missing_raw_body");
        res.status(500).json({ error: "missing_raw_body" });
        return;
      }
      const response = await billing.handleWebhook(
        new Request(`http://localhost${req.originalUrl}`, { method: req.method, headers: toHeaders(req), body: new Uint8Array(req.body) })
      );
      await forward(response, res);
    } catch {
      fail(billing, res);
    }
  };
}
function paddleHealth(billing) {
  return async (req, res) => {
    try {
      const response = await billing.handleHealth(
        new Request(`http://localhost${req.originalUrl}`, { method: req.method, headers: toHeaders(req) })
      );
      await forward(response, res);
    } catch {
      fail(billing, res);
    }
  };
}
export {
  paddleHealth,
  paddleWebhook
};
