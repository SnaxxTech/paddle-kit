import {
  LIVE_BASE,
  PaddleError,
  SANDBOX_BASE,
  paddleClient
} from "../chunk-EMR6PZ3J.js";

// src/price/index.ts
var PriceError = class extends PaddleError {
  constructor(code, message, status) {
    super(message, status);
    this.code = code;
  }
  code;
  name = "PriceError";
};
var INTERVALS = ["day", "week", "month", "year"];
function priceFrom(data) {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const { id, unit_price: unit, billing_cycle: cycle, name, status } = data;
  if (typeof id !== "string" || !id) return null;
  if (typeof unit?.amount !== "string" || !/^\d+$/.test(unit.amount) || typeof unit.currency_code !== "string" || !/^[A-Z]{3}$/.test(unit.currency_code)) return null;
  if (status !== "active" && status !== "archived") return null;
  if (name !== null && name !== void 0 && typeof name !== "string") return null;
  let interval = null;
  if (cycle !== null && cycle !== void 0) {
    if (!INTERVALS.includes(cycle.interval) || !Number.isSafeInteger(cycle.frequency) || cycle.frequency < 1) return null;
    interval = { interval: cycle.interval, frequency: cycle.frequency };
  }
  return { id, amount: unit.amount, currency: unit.currency_code, interval, name: name ?? null, status };
}
async function getPrice(priceId, opts) {
  const keyEnv = opts.apiKey?.startsWith("pdl_sdbx_") ? "sandbox" : opts.apiKey?.startsWith("pdl_live_") ? "production" : null;
  if (keyEnv !== opts.environment) throw new PriceError("unauthorized", `API key does not match environment "${opts.environment}"`);
  if (typeof priceId !== "string" || !/^pri_[A-Za-z0-9]+$/.test(priceId)) throw new PriceError("not_found", "priceId is not a Paddle price id (pri_\u2026)");
  const timeoutMs = opts.timeoutMs ?? 5e3;
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new PriceError("timeout", `GET /prices/${priceId}: no answer in ${timeoutMs} ms`));
      controller.abort();
    }, timeoutMs);
  });
  const fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  const api = paddleClient(opts.environment === "production" ? LIVE_BASE : SANDBOX_BASE, opts.apiKey, fetchImpl, [opts.apiKey], controller.signal);
  let body;
  try {
    body = await Promise.race([api.call("GET", `/prices/${priceId}`), timeout]);
  } catch (error) {
    if (error instanceof PriceError) throw error;
    if (error instanceof PaddleError && error.status !== void 0) {
      const code = error.status === 401 || error.status === 403 ? "unauthorized" : error.status === 404 ? "not_found" : "http";
      throw new PriceError(code, error.message, error.status);
    }
    throw new PriceError("network", `GET /prices/${priceId}: network error`);
  } finally {
    clearTimeout(timer);
  }
  const price = priceFrom(body.data);
  if (!price) throw new PriceError("malformed", `GET /prices/${priceId}: the answer is not a price`);
  return price;
}
function formatPrice(amount, currency, locale = "en-US") {
  const digits = new Intl.NumberFormat(locale, { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const value = Number(amount) / 10 ** digits;
  if (!Number.isFinite(value)) throw new RangeError("formatPrice: amount is not a number");
  const whole = Number.isInteger(value);
  return new Intl.NumberFormat(locale, { style: "currency", currency, ...whole ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {} }).format(value);
}
export {
  PriceError,
  formatPrice,
  getPrice
};
