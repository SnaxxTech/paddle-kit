import {
  LIVE_BASE,
  PaddleError,
  SANDBOX_BASE,
  paddleClient,
  redactSecrets
} from "./chunk-U2MNQW4V.js";
import {
  EVENT_TYPES
} from "./chunk-NSUHMBM5.js";

// src/catalog/index.ts
import { chmodSync, existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
var EVENTS = Object.values(EVENT_TYPES).flat();
var CYCLES = ["monthly", "yearly", "once"];
var TAX_CATEGORIES = [
  "digital-goods",
  "ebooks",
  "implementation-services",
  "professional-services",
  "saas",
  "software-programming-services",
  "standard",
  "training-services",
  "website-hosting"
];
var CatalogError = class extends Error {
  name = "CatalogError";
};
var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;
function fail(field, why) {
  throw new CatalogError(`catalog ${field}: ${why}`);
}
function onlyKeys(obj, allowed, where) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail(where ? `${where}.${k}` : k, `unknown key (allowed: ${allowed.join(", ")})`);
  }
}
function validateCatalog(input) {
  if (!isObj(input)) fail("(root)", "must be a JSON object");
  onlyKeys(input, ["$schema", "app", "product", "prices"], "");
  if (input.$schema !== void 0 && typeof input.$schema !== "string") fail("$schema", "must be a string");
  const { app, product, prices } = input;
  if (!nonEmpty(app) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(app)) {
    fail("app", "must be a non-empty identifier (letters, digits, . _ -)");
  }
  if (!isObj(product)) fail("product", "must be an object");
  onlyKeys(product, ["name", "taxCategory", "description"], "product");
  if (!nonEmpty(product.name)) fail("product.name", "must be a non-empty string");
  const taxCategory = product.taxCategory === void 0 ? "standard" : product.taxCategory;
  if (typeof taxCategory !== "string" || !TAX_CATEGORIES.includes(taxCategory)) {
    fail("product.taxCategory", `must be one of ${TAX_CATEGORIES.join(", ")}`);
  }
  if (product.description !== void 0 && typeof product.description !== "string") {
    fail("product.description", "must be a string");
  }
  if (!Array.isArray(prices) || prices.length === 0) fail("prices", "must be a non-empty array");
  const seen = /* @__PURE__ */ new Set();
  const out = prices.map((raw, i) => {
    const at = (f) => `prices[${i}].${f}`;
    if (!isObj(raw)) fail(`prices[${i}]`, "must be an object");
    onlyKeys(raw, ["key", "cycle", "name", "amount", "currency", "description", "quantity"], `prices[${i}]`);
    if (!nonEmpty(raw.key) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(raw.key)) {
      fail(at("key"), "must start with a letter and use only letters, digits and _");
    }
    if (typeof raw.cycle !== "string" || !CYCLES.includes(raw.cycle)) {
      fail(at("cycle"), `must be one of ${CYCLES.join(", ")}`);
    }
    const cycle = raw.cycle;
    if (!nonEmpty(raw.name)) fail(at("name"), "must be a non-empty string");
    const amountIn = raw.amount;
    const amount = typeof amountIn === "number" && Number.isSafeInteger(amountIn) && amountIn >= 0 ? String(amountIn) : amountIn;
    if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
      fail(at("amount"), 'must be a whole number in the lowest currency unit, as a string (e.g. "1000")');
    }
    if (typeof raw.currency !== "string" || !/^[A-Z]{3}$/.test(raw.currency)) {
      fail(at("currency"), 'must be a 3-letter upper-case ISO code (e.g. "USD")');
    }
    if (raw.description !== void 0 && typeof raw.description !== "string") fail(at("description"), "must be a string");
    let quantity;
    if (raw.quantity !== void 0) {
      const q = raw.quantity;
      if (!isObj(q)) fail(at("quantity"), "must be an object { min, max }");
      onlyKeys(q, ["min", "max"], at("quantity"));
      const { min, max } = q;
      if (typeof min !== "number" || !Number.isSafeInteger(min) || min < 1) fail(at("quantity.min"), "must be an integer >= 1");
      if (typeof max !== "number" || !Number.isSafeInteger(max) || max < min) {
        fail(at("quantity.max"), "must be an integer >= quantity.min");
      }
      quantity = { min, max };
    }
    const tag = `${raw.key}-${cycle}`;
    if (seen.has(tag)) fail(at("key"), `duplicate price "${raw.key}" with cycle "${cycle}"`);
    seen.add(tag);
    const price = { key: raw.key, cycle, name: raw.name, amount, currency: raw.currency };
    if (typeof raw.description === "string") price.description = raw.description;
    if (quantity) price.quantity = quantity;
    return price;
  });
  const cleaned = {
    app,
    product: { name: product.name, taxCategory },
    prices: out
  };
  if (typeof product.description === "string") cleaned.product.description = product.description;
  return cleaned;
}
function readCatalogFile(file) {
  if (!existsSync(file)) throw new CatalogError(`catalog file not found: ${file}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new CatalogError(`catalog file is not valid JSON: ${file}`);
  }
  return validateCatalog(parsed);
}
function toPriceMap(catalog, ids) {
  const map = {};
  for (const p of catalog.prices) {
    const id = ids[`${p.key}-${p.cycle}`];
    if (!id) continue;
    const onlyOnce = catalog.prices.filter((x) => x.key === p.key).every((x) => x.cycle === "once");
    if (onlyOnce) {
      map[p.key] = id;
    } else {
      const entry = map[p.key] ??= {};
      entry[p.cycle] = id;
    }
  }
  return map;
}
function readEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    let value = (m[2] ?? "").trim();
    if (value.length > 1 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}
function writeEnvFile(file, updates) {
  const clean = /* @__PURE__ */ new Map();
  for (const [k, v] of Object.entries(updates)) {
    if (typeof v !== "string" || v === "" || v === "undefined" || v === "null") continue;
    if (/[\r\n]/.test(v)) continue;
    clean.set(k, v);
  }
  const current = readEnvFile(file);
  for (const [k, v] of [...clean]) if (current[k] === v) clean.delete(k);
  if (clean.size === 0) return [];
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const pending = new Map(clean);
  const replaced = /* @__PURE__ */ new Set();
  const next = [];
  for (const line of lines) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = m?.[1];
    if (key && clean.has(key)) {
      if (!replaced.has(key)) next.push(`${key}=${clean.get(key)}`);
      replaced.add(key);
      pending.delete(key);
      continue;
    }
    next.push(line);
  }
  for (const [k, v] of pending) next.push(`${k}=${v}`);
  writeFileSync(file, next.join("\n") + "\n", { mode: 384 });
  chmodSync(file, 384);
  return [...clean.keys()];
}
function displayAmount(amount, currency) {
  let digits = 2;
  try {
    digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
  }
  return (Number(amount) / 10 ** digits).toFixed(digits);
}
var isActive = (item) => item.status !== "archived";
var sameSet = (a, b) => {
  if (!Array.isArray(a)) return false;
  const x = new Set(a.map(String));
  return x.size === b.length && b.every((e) => x.has(e));
};
function describeKey(apiKey, live) {
  if (apiKey.startsWith("pdl_sdbx_")) {
    if (live) throw new PaddleError("--live was given with a sandbox key (pdl_sdbx_\u2026): drop --live, or use a live key");
    return "sandbox";
  }
  if (!live) throw new PaddleError("Sandbox API key required (pdl_sdbx_\u2026). Pass --live to use a live key on purpose.");
  if (!apiKey.startsWith("pdl_live_")) throw new PaddleError("Unrecognised API key: expected pdl_sdbx_\u2026 or (with --live) pdl_live_\u2026");
  return "production";
}
async function syncCatalog(opts) {
  const known = [opts.apiKey];
  const sink = opts.log ?? ((line) => console.log(line));
  const log = (line) => sink(redactSecrets(line, known));
  const live = opts.live === true;
  const catalog = validateCatalog(opts.catalog);
  const environment = describeKey(opts.apiKey ?? "", live);
  if (opts.webhookUrl !== void 0) {
    let parsed = null;
    try {
      parsed = new URL(opts.webhookUrl);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.protocol !== "https:" || !parsed.hostname) throw new PaddleError("webhookUrl needs an https URL");
  }
  const env = opts.envFile ? readEnvFile(opts.envFile) : {};
  if (environment === "production" && !opts.teardown && env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN?.startsWith("test_")) {
    throw new PaddleError("Refusing to use a test_ client token with --live: use a separate env file for live (--env-file .env.production.local --live)");
  }
  const fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  const paddle = paddleClient(environment === "sandbox" ? SANDBOX_BASE : LIVE_BASE, opts.apiKey, fetchImpl, known);
  const destinationName = `${catalog.app} (paddle-kit)`;
  const rows = [];
  const written = [];
  const pendingEnv = {};
  const put = (values) => {
    for (const [k, v] of Object.entries(values)) if (typeof v === "string" && v !== "" && v !== "undefined") pendingEnv[k] = v;
    if (opts.envFile) {
      for (const k of writeEnvFile(opts.envFile, values)) if (!written.includes(k)) written.push(k);
    }
  };
  const done = (productId, priceIds) => {
    printTable(log, rows);
    if (written.length) log(`Wrote to ${path.basename(opts.envFile ?? "")}: ${written.join(", ")}`);
    if (opts.envFile && existsSync(opts.envFile)) chmodSync(opts.envFile, 384);
    const result = { environment, productId, priceIds, prices: toPriceMap(catalog, priceIds), rows, written };
    if (!opts.envFile) result.env = { ...pendingEnv };
    return result;
  };
  const products = await paddle.list("/products?per_page=200");
  let product = products.find((p) => isActive(p) && p.custom_data?.paddle_kit === catalog.app);
  if (opts.teardown) {
    const destinations = await paddle.list("/notification-settings");
    const destination = destinations.find((d) => d.description === destinationName);
    if (destination) {
      await paddle.call("PATCH", `/notification-settings/${destination.id}`, { active: false });
      rows.push(["destination (deactivated)", destination.id, ""]);
    }
    if (product) {
      const prices = (await paddle.list(`/prices?product_id=${product.id}&per_page=200`)).filter(isActive);
      let unmarked = 0;
      for (const price of prices) {
        if (typeof price.custom_data?.paddle_kit_price !== "string") {
          unmarked++;
          continue;
        }
        await paddle.call("PATCH", `/prices/${price.id}`, { status: "archived" });
        rows.push([`price ${price.custom_data.paddle_kit_price} (archived)`, price.id, ""]);
      }
      if (unmarked === 0) {
        await paddle.call("PATCH", `/products/${product.id}`, { status: "archived" });
        rows.push(["product (archived)", product.id, ""]);
      } else {
        rows.push(["product (kept: has prices paddle-kit did not create)", product.id, `${unmarked} active`]);
      }
    }
    return done(product?.id ?? null, {});
  }
  const wantedProduct = {
    name: catalog.product.name,
    tax_category: catalog.product.taxCategory,
    ...catalog.product.description !== void 0 ? { description: catalog.product.description } : {}
  };
  if (!product) {
    product = (await paddle.call("POST", "/products", { ...wantedProduct, custom_data: { paddle_kit: catalog.app } })).data;
    rows.push(["product (created)", product.id, catalog.product.name]);
  } else {
    const drift = {};
    if (product.name !== wantedProduct.name) drift.name = wantedProduct.name;
    if (product.tax_category !== wantedProduct.tax_category) drift.tax_category = wantedProduct.tax_category;
    if (wantedProduct.description !== void 0 && (product.description ?? null) !== wantedProduct.description) {
      drift.description = wantedProduct.description;
    }
    if (Object.keys(drift).length) await paddle.call("PATCH", `/products/${product.id}`, drift);
    rows.push([`product${Object.keys(drift).length ? " (updated)" : ""}`, product.id, catalog.product.name]);
  }
  const existing = (await paddle.list(`/prices?product_id=${product.id}&per_page=200`)).filter(isActive);
  const ids = {};
  for (const want of catalog.prices) {
    const tag = `${want.key}-${want.cycle}`;
    const unitPrice = { amount: want.amount, currency_code: want.currency };
    const quantity = want.quantity ? { minimum: want.quantity.min, maximum: want.quantity.max } : void 0;
    let price = existing.find((p) => p.custom_data?.paddle_kit_price === tag);
    let note = "";
    if (!price) {
      price = (await paddle.call("POST", "/prices", {
        product_id: product.id,
        name: want.name,
        description: want.description ?? want.name,
        unit_price: unitPrice,
        // `once` = a one-time price: no billing_cycle at all.
        ...want.cycle === "once" ? {} : { billing_cycle: { interval: want.cycle === "monthly" ? "month" : "year", frequency: 1 } },
        ...quantity ? { quantity } : {},
        custom_data: { paddle_kit_price: tag }
      })).data;
      note = "created";
    } else {
      const drift = {};
      if (price.unit_price?.amount !== unitPrice.amount || price.unit_price?.currency_code !== unitPrice.currency_code) {
        drift.unit_price = unitPrice;
      }
      if (quantity && (price.quantity?.minimum !== quantity.minimum || price.quantity?.maximum !== quantity.maximum)) {
        drift.quantity = quantity;
      }
      if (price.name !== want.name) drift.name = want.name;
      if (Object.keys(drift).length) {
        await paddle.call("PATCH", `/prices/${price.id}`, drift);
        note = `updated ${Object.keys(drift).join(", ")}${drift.unit_price ? ` (was ${price.unit_price?.amount})` : ""}`;
      }
    }
    ids[tag] = price.id;
    rows.push([`price ${tag}`, price.id, `${displayAmount(want.amount, want.currency)} ${want.currency}${note ? ` (${note})` : ""}`]);
  }
  put({ PADDLE_ENV: environment, PADDLE_PRICES: JSON.stringify(toPriceMap(catalog, ids)) });
  if (opts.webhookUrl) {
    const url = opts.webhookUrl;
    const settings = await paddle.list("/notification-settings");
    const found = settings.find((d) => d.description === destinationName);
    let secret;
    if (!found) {
      const created = (await paddle.call("POST", "/notification-settings", {
        description: destinationName,
        destination: url,
        type: "url",
        traffic_source: "all",
        subscribed_events: EVENTS,
        include_sensitive_fields: false
      })).data;
      secret = created.endpoint_secret_key;
      rows.push(["destination (created)", created.id, url]);
    } else {
      const drift = {};
      if (found.destination !== url) drift.destination = url;
      if (found.active !== true) drift.active = true;
      if (!sameSet(found.subscribed_events?.map?.((e) => typeof e === "string" ? e : e?.name), EVENTS)) {
        drift.subscribed_events = EVENTS;
      }
      if (Object.keys(drift).length) await paddle.call("PATCH", `/notification-settings/${found.id}`, drift);
      rows.push([`destination (existing${Object.keys(drift).length ? ", updated" : ""})`, found.id, url]);
      secret = found.endpoint_secret_key;
    }
    if (typeof secret === "string" && secret !== "") {
      known.push(secret);
      put({ PADDLE_NOTIFICATION_WEBHOOK_SECRET: secret });
    } else {
      log("Destination returned no secret: copy it from the Paddle dashboard into PADDLE_NOTIFICATION_WEBHOOK_SECRET");
    }
    if (!env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN) {
      const token = (await paddle.call("POST", "/client-tokens", { name: `${catalog.app} (paddle-kit)`, description: "created by paddle-kit-catalog" })).data;
      if (typeof token?.token === "string") known.push(token.token);
      if (environment === "production" && String(token?.token ?? "").startsWith("test_")) {
        throw new PaddleError("Refusing a test_ client token with --live");
      }
      if (typeof token?.token === "string" && token.token !== "") put({ NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: token.token });
      else log("Paddle returned no client token: create one in the dashboard");
    }
  }
  return done(product.id, ids);
}
function printTable(log, rows) {
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => (r[i] ?? "").length), 0));
  for (const r of rows) log(r.map((cell, i) => (cell ?? "").padEnd(widths[i])).join("  ").trimEnd());
}

export {
  EVENTS,
  CatalogError,
  validateCatalog,
  readCatalogFile,
  toPriceMap,
  readEnvFile,
  writeEnvFile,
  describeKey,
  syncCatalog
};
