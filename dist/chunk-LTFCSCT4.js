import {
  LIVE_BASE,
  PaddleError,
  SANDBOX_BASE,
  paddleClient
} from "./chunk-EHTDG5JE.js";

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
async function withApi(what, opts, work) {
  const keyEnv = opts.apiKey?.startsWith("pdl_sdbx_") ? "sandbox" : opts.apiKey?.startsWith("pdl_live_") ? "production" : null;
  if (keyEnv !== opts.environment) throw new PriceError("unauthorized", `API key does not match environment "${opts.environment}"`);
  const timeoutMs = opts.timeoutMs ?? 5e3;
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new PriceError("timeout", `${what}: no answer in ${timeoutMs} ms`));
      controller.abort();
    }, timeoutMs);
  });
  const fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  const api = paddleClient(opts.environment === "production" ? LIVE_BASE : SANDBOX_BASE, opts.apiKey, fetchImpl, [opts.apiKey], controller.signal);
  try {
    return await Promise.race([work(api), timeout]);
  } catch (error) {
    if (error instanceof PriceError) throw error;
    if (error instanceof PaddleError && error.status !== void 0) {
      const code = error.status === 401 || error.status === 403 ? "unauthorized" : error.status === 404 ? "not_found" : "http";
      throw new PriceError(code, error.message, error.status);
    }
    if (error instanceof PaddleError) throw new PriceError("malformed", error.message);
    throw new PriceError("network", `${what}: network error`);
  } finally {
    clearTimeout(timer);
  }
}
async function getPrice(priceId, opts) {
  const what = `GET /prices/${priceId}`;
  return withApi(what, opts, async (api) => {
    if (typeof priceId !== "string" || !/^pri_[A-Za-z0-9]+$/.test(priceId)) throw new PriceError("not_found", "priceId is not a Paddle price id (pri_\u2026)");
    const price = priceFrom((await api.call("GET", `/prices/${priceId}`)).data);
    if (!price) throw new PriceError("malformed", `${what}: the answer is not a price`);
    return price;
  });
}
var LABEL = /^([A-Za-z][A-Za-z0-9_]*)-(monthly|yearly|once)$/;
async function labelled(app, api) {
  const byLabel = /* @__PURE__ */ new Map();
  for (const p of await api.list("/prices?status=active&include=product&per_page=200")) {
    const label = p.custom_data?.paddle_kit_price;
    if (p.status !== "active" || typeof label !== "string" || !LABEL.test(label)) continue;
    if (p.product?.custom_data?.paddle_kit !== app || p.product?.status === "archived") continue;
    byLabel.set(label, [...byLabel.get(label) ?? [], p]);
  }
  return byLabel;
}
async function findPrice(label, opts) {
  const tag = `${label.key}-${label.cycle}`;
  const what = `price "${tag}" of app "${label.app}"`;
  return withApi(what, opts, async (api) => {
    const found = (await labelled(label.app, api)).get(tag) ?? [];
    if (found.length === 0) throw new PriceError("not_found", `${what}: no active price has this label (run paddle-kit-catalog)`);
    if (found.length > 1) throw new PriceError("ambiguous", `${what}: ${found.length} active prices have this label (${found.map((p) => p.id).join(", ")}): archive all but one`);
    const price = priceFrom(found[0]);
    if (!price) throw new PriceError("malformed", `${what}: the answer is not a price`);
    return price;
  });
}
async function findPriceMap(app, opts) {
  return withApi(`prices of app "${app}"`, opts, async (api) => {
    const map = {};
    const byLabel = [...await labelled(app, api)].sort(([a], [b]) => a.localeCompare(b));
    for (const [label, found] of byLabel) {
      if (found.length > 1) throw new PriceError("ambiguous", `price "${label}" of app "${app}": ${found.length} active prices have this label: archive all but one`);
      const [, key, cycle] = LABEL.exec(label);
      const onlyOnce = byLabel.every(([l]) => !l.startsWith(`${key}-`) || l === `${key}-once`);
      if (onlyOnce) map[key] = found[0].id;
      else (map[key] ??= {})[cycle] = found[0].id;
    }
    return map;
  });
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
  getPrice,
  findPrice,
  findPriceMap,
  formatPrice
};
