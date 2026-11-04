import {
  PriceError,
  findPriceMap
} from "../chunk-LTFCSCT4.js";
import {
  FULFILMENT_SCHEMA,
  MIGRATION_OF_TABLE
} from "../chunk-CNOCPEFW.js";
import {
  LIVE_BASE,
  PADDLE_API_VERSION,
  SANDBOX_BASE
} from "../chunk-EHTDG5JE.js";
import {
  createBilling,
  createPaddleTransport,
  isOwnsResolver
} from "../chunk-HOLH4XUU.js";
import "../chunk-UYGU5JF5.js";
import "../chunk-YUI76V23.js";
import "../chunk-74Z3S4IU.js";

// src/config/readiness.ts
var RECOVERY_PERMISSIONS = ["notification.read", "subscription.read", "transaction.read", "adjustment.read"];
var PRICE_PERMISSIONS = ["price.read", "product.read"];
function readinessChecks(opts) {
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  const needed = [.../* @__PURE__ */ new Set([...RECOVERY_PERMISSIONS, ...opts.resolvesPrices ? PRICE_PERMISSIONS : [], ...opts.permissions ?? []])];
  let cached = null;
  let inFlight = null;
  async function askPaddle() {
    if (!opts.apiKey) return { ok: false, detail: "PADDLE_API_KEY is missing" };
    let res;
    try {
      res = await fetchImpl(`${opts.environment === "production" ? LIVE_BASE : SANDBOX_BASE}/`, {
        method: "GET",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Paddle-Version": String(PADDLE_API_VERSION) },
        redirect: "manual"
        // Cloudflare Workers rejects 'error'; a 3xx is not ok and reported below
      });
    } catch {
      return { ok: false, detail: "Paddle did not answer" };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, detail: `Paddle refused the API key (${res.status}): wrong, revoked, or a key of the other environment` };
    if (!res.ok) return { ok: false, detail: `Paddle answered ${res.status}` };
    const data = (await res.json().catch(() => null))?.data;
    const keyEnv = data?.api?.environment;
    if (keyEnv && keyEnv !== opts.environment) return { ok: false, detail: `the API key is for ${keyEnv}, the app runs ${opts.environment}` };
    const have = Array.isArray(data?.caller?.permissions) ? data.caller.permissions : null;
    if (!have) return { ok: false, detail: "Paddle did not list the key's permissions" };
    const missing = needed.filter((p) => !have.includes(p));
    return missing.length > 0 ? { ok: false, detail: `missing permissions: ${missing.join(", ")}` } : { ok: true, detail: `${needed.length} permissions present` };
  }
  const checks = {
    async paddle_api_key() {
      const ttl = (cached?.result.ok ? opts.cacheSeconds ?? 600 : 60) * 1e3;
      if (cached && now() - cached.at < ttl) return cached.result;
      inFlight ??= askPaddle().then((result) => {
        cached = { at: now(), result };
        return result;
      }).finally(() => {
        inFlight = null;
      });
      return inFlight;
    }
  };
  if (opts.store) {
    const store = opts.store;
    checks.migrations = async () => {
      if (store.checkSchema) {
        let missing;
        try {
          ({ missing } = await store.checkSchema(opts.fulfilment ? FULFILMENT_SCHEMA : void 0));
        } catch {
          return { ok: false, detail: "the store did not answer (connection or permissions), so the schema was not checked" };
        }
        if (missing.length === 0) return { ok: true };
        const migrations = [...new Set(missing.map((m) => MIGRATION_OF_TABLE[m.split(".")[0]]).filter(Boolean))];
        return { ok: false, detail: `missing ${missing.join(", ")} (run ${migrations.join(", ")})` };
      }
      try {
        if (!store.recovery || !store.getOwnedIds) return { ok: false, detail: "the store has no recovery or owned ids (migrations 003, 004)" };
        await store.recovery.getRecovery(opts.environment);
        await store.getOwnedIds();
        return { ok: true, detail: "partly checked: the store has no checkSchema" };
      } catch {
        return { ok: false, detail: "reading paddle_recovery or paddle_owned_ids failed (migration 003/004 missing, or the store did not answer)" };
      }
    };
  }
  if ("cronSecret" in opts) {
    checks.cron_secret = async () => {
      if (!opts.cronSecret) return { ok: false, detail: "CRON_SECRET is missing" };
      if (opts.cronSecret.length < 16) return { ok: false, detail: "CRON_SECRET is shorter than 16 characters" };
      return { ok: true };
    };
  }
  return checks;
}

// src/config/products.ts
function defineProducts(prices, products) {
  const assigned = [];
  for (const [key, def] of Object.entries(products)) {
    const entry = prices[key];
    if (entry === void 0) throw new Error(`paddle-kit: PADDLE_PRICES has no "${key}" for products`);
    const onSale = typeof entry === "string" ? [[null, entry]] : Object.entries(entry);
    for (const [cycle, id] of onSale) assigned.push({ id, key, cycle, retired: false });
    for (const id of new Set(def.retiredPriceIds ?? [])) assigned.push({ id, key, cycle: null, retired: true });
  }
  const entitlements = {};
  const owner = /* @__PURE__ */ new Map();
  for (const { id, ...o } of assigned) {
    const first = owner.get(id);
    if (first && first.retired !== o.retired) throw new Error(`paddle-kit: retired price ${id} is on sale (PADDLE_PRICES)`);
    if (first && first.key !== o.key) throw new Error(`paddle-kit: price ${id} belongs to two products ("${first.key}", "${o.key}")`);
    if (first) continue;
    entitlements[id] = products[o.key].features;
    owner.set(id, o);
  }
  return {
    entitlements,
    priceIds: [...owner.keys()],
    checkoutPriceId(key, cycle) {
      const entry = key in products ? prices[key] : void 0;
      const id = typeof entry === "string" ? cycle === void 0 ? entry : void 0 : cycle === void 0 ? void 0 : entry?.[cycle];
      if (!id) throw new Error(`paddle-kit: no price "${key}"${cycle === void 0 ? "" : ` for cycle "${cycle}"`} on sale`);
      return id;
    },
    productOf: (priceId) => owner.get(priceId) ?? null
  };
}

// src/config/index.ts
var WATCHED = [
  "PADDLE_ENV",
  "PADDLE_NOTIFICATION_WEBHOOK_SECRET",
  "PADDLE_PRICES",
  "NEXT_PUBLIC_PADDLE_CLIENT_TOKEN",
  "BILLING_LAUNCH_AT",
  "BILLING_ENFORCE"
];
var ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
var nonEmpty = (v) => typeof v === "string" && v.trim().length > 0 && v === v.trim();
var isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function parsePrice(v) {
  if (nonEmpty(v)) return v;
  if (!isPlainObject(v)) return null;
  const entries = Object.entries(v);
  if (entries.length === 0 || !entries.every(([, id]) => nonEmpty(id))) return null;
  return Object.fromEntries(entries);
}
function readBillingEnv(env, opts) {
  if (!WATCHED.some((name) => env[name])) return { config: null, problems: [] };
  const problems = [];
  let environment = "sandbox";
  if (env.PADDLE_ENV) {
    if (env.PADDLE_ENV === "sandbox" || env.PADDLE_ENV === "production") environment = env.PADDLE_ENV;
    else problems.push('PADDLE_ENV must be "sandbox" or "production"');
  }
  const webhookSecret = env.PADDLE_NOTIFICATION_WEBHOOK_SECRET;
  const webhookSecrets = webhookSecret?.split(",") ?? [];
  if (!webhookSecret?.trim()) problems.push("PADDLE_NOTIFICATION_WEBHOOK_SECRET is missing");
  else if (webhookSecrets.some((x) => x !== x.trim())) problems.push("PADDLE_NOTIFICATION_WEBHOOK_SECRET has leading or trailing whitespace");
  else if (!webhookSecrets.every(nonEmpty)) problems.push("PADDLE_NOTIFICATION_WEBHOOK_SECRET has an empty entry between commas");
  const resolving = opts.resolvePrices !== void 0 && !env.PADDLE_PRICES;
  let prices = null;
  if (resolving) {
    prices = {};
    if (!env.PADDLE_API_KEY) problems.push("PADDLE_API_KEY is missing (needed to find the prices in Paddle while PADDLE_PRICES is unset)");
  } else if (!env.PADDLE_PRICES) {
    problems.push("PADDLE_PRICES is missing");
  } else {
    let parsed;
    try {
      parsed = JSON.parse(env.PADDLE_PRICES);
    } catch {
      parsed = void 0;
    }
    if (!isPlainObject(parsed)) {
      problems.push("PADDLE_PRICES is not a JSON object of price ids");
    } else {
      const map = {};
      let malformed = false;
      for (const [key, value] of Object.entries(parsed)) {
        const price = parsePrice(value);
        if (price === null) {
          if (opts.requiredPrices.includes(key)) problems.push(`PADDLE_PRICES entry "${key}" is not a price id or a map of cycle to price id`);
          else malformed = true;
        } else {
          map[key] = price;
        }
      }
      if (malformed) problems.push("PADDLE_PRICES has an entry that is not a price id or a map of cycle to price id");
      for (const key of opts.requiredPrices) {
        if (!Object.hasOwn(parsed, key)) problems.push(`PADDLE_PRICES is missing required price "${key}"`);
        else {
          const price = map[key];
          if (price !== void 0 && typeof price !== "string") {
            for (const cycle of opts.requiredCycles ?? []) {
              if (!Object.hasOwn(price, cycle)) problems.push(`PADDLE_PRICES entry "${key}" is missing cycle "${cycle}"`);
            }
          }
        }
      }
      prices = map;
    }
  }
  const envValid = !env.PADDLE_ENV || env.PADDLE_ENV === "sandbox" || env.PADDLE_ENV === "production";
  const clientToken = env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN ?? "";
  if (!clientToken.trim()) problems.push("NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is missing");
  else if (clientToken !== clientToken.trim()) problems.push("NEXT_PUBLIC_PADDLE_CLIENT_TOKEN has leading or trailing whitespace");
  else if (envValid && !clientToken.startsWith(environment === "production" ? "live_" : "test_"))
    problems.push("NEXT_PUBLIC_PADDLE_CLIENT_TOKEN does not match PADDLE_ENV (test_ = sandbox, live_ = production)");
  let launchAt = null;
  if (env.BILLING_LAUNCH_AT) {
    const ms = ISO_WITH_ZONE.test(env.BILLING_LAUNCH_AT) ? Date.parse(env.BILLING_LAUNCH_AT) : Number.NaN;
    if (Number.isNaN(ms)) problems.push("BILLING_LAUNCH_AT is not an ISO date-time with a timezone (e.g. 2026-10-20T00:00:00Z)");
    else launchAt = ms;
  } else if (opts.requireLaunchAt) {
    problems.push("BILLING_LAUNCH_AT is missing");
  }
  const healthToken = env.PADDLE_HEALTH_TOKEN;
  if (healthToken && healthToken !== healthToken.trim()) problems.push("PADDLE_HEALTH_TOKEN has leading or trailing whitespace");
  const apiKey = env.PADDLE_API_KEY || void 0;
  if (apiKey && envValid && !apiKey.startsWith(environment === "production" ? "pdl_live_" : "pdl_sdbx_"))
    problems.push("PADDLE_API_KEY does not match PADDLE_ENV (pdl_sdbx_ = sandbox, pdl_live_ = production)");
  if (problems.length > 0 || !nonEmpty(webhookSecret) || !prices) return { config: null, problems };
  const config = {
    environment,
    webhookSecret: webhookSecrets[0],
    webhookSecrets,
    prices,
    clientToken,
    launchAt,
    enforce: env.BILLING_ENFORCE === "1"
  };
  if (env.PADDLE_HEALTH_TOKEN) config.healthToken = env.PADDLE_HEALTH_TOKEN;
  if (apiKey) config.apiKey = apiKey;
  const priceIds2 = priceIdsOf(prices);
  const lookup = opts.resolvePrices;
  if (!lookup) {
    if (priceIds2.length > 0) config.owns = { priceIds: priceIds2 };
    return { config, problems };
  }
  const fixed = prices;
  const resolvePrices = resolving ? memo(async () => checkRequired(await findPriceMap(lookup.app, { apiKey, environment, fetch: lookup.fetch, timeoutMs: lookup.timeoutMs }), lookup.app, opts), (lookup.cacheSeconds ?? 600) * 1e3) : async () => fixed;
  const withLookup = { ...config, resolvePrices };
  if (resolving) withLookup.owns = { resolve: async () => ({ priceIds: priceIdsOf(await resolvePrices()) }) };
  else if (priceIds2.length > 0) withLookup.owns = { priceIds: priceIds2 };
  return { config: withLookup, problems };
}
function priceIds(entry) {
  if (entry === void 0) return [];
  return typeof entry === "string" ? [entry] : Object.values(entry);
}
function priceIdOf(prices, key, cycle) {
  const entry = prices[key];
  const id = typeof entry === "string" ? cycle === void 0 ? entry : void 0 : cycle === void 0 ? void 0 : entry?.[cycle];
  if (!id) throw new Error(`paddle-kit: no price "${key}"${cycle === void 0 ? "" : ` for cycle "${cycle}"`}`);
  return id;
}
var priceIdsOf = (prices) => [...new Set(Object.values(prices).flatMap(priceIds))];
function checkRequired(map, app, opts) {
  for (const key of opts.requiredPrices) {
    const price = map[key];
    if (price === void 0) throw new PriceError("not_found", `app "${app}" has no active price labelled "${key}-\u2026" in Paddle (run paddle-kit-catalog)`);
    if (typeof price === "string") continue;
    for (const cycle of opts.requiredCycles ?? []) {
      if (!Object.hasOwn(price, cycle)) throw new PriceError("not_found", `app "${app}" has no active price labelled "${key}-${cycle}" in Paddle`);
    }
  }
  return map;
}
function memo(fn, ms) {
  let kept = null;
  return () => {
    const at = Date.now();
    if (kept && at - kept.at < ms) return kept.value;
    const value = fn();
    const entry = { at, value };
    kept = entry;
    value.catch(() => {
      if (kept === entry) kept = null;
    });
    return value;
  };
}
function billingFromEnv(env, opts) {
  const enforce = env.BILLING_ENFORCE === "1";
  const { requiredPrices: required, requiredCycles, requireLaunchAt, resolvePrices: lookup, entitlements, owns, readiness, products: productDefs, ...rest } = opts;
  const requiredPrices = [.../* @__PURE__ */ new Set([...required ?? [], ...Object.keys(productDefs ?? {})])];
  const transport = createPaddleTransport();
  const resolvePrices = lookup && { ...lookup, fetch: lookup.fetch ?? transport.fetch };
  const { config, problems } = readBillingEnv(env, { requiredPrices, requiredCycles, requireLaunchAt, resolvePrices });
  if (!config) return { billing: null, config: null, problems, enforce, products: productDefs ? null : void 0 };
  let products;
  if (productDefs) {
    try {
      products = defineProducts(config.prices, productDefs);
    } catch (error) {
      return { billing: null, config: null, problems: [...problems, error.message], enforce, products: null };
    }
  }
  const durable = !owns && isOwnsResolver(config.owns) && rest.store.getOwnedIds ? storedOwnership(rest.store) : void 0;
  const billing = createBilling({
    paddleFetch: transport.fetch,
    ...rest,
    environment: config.environment,
    webhookSecret: config.webhookSecrets ?? config.webhookSecret,
    healthToken: config.healthToken,
    owns: owns ?? durable ?? (products && config.owns && !isOwnsResolver(config.owns) && "priceIds" in config.owns ? { priceIds: [.../* @__PURE__ */ new Set([...config.owns.priceIds, ...products.priceIds])] } : config.owns),
    catalogApp: resolvePrices?.app,
    entitlements: { ...products?.entitlements, ...typeof entitlements === "function" ? entitlements(config) : entitlements ?? {} },
    healthChecks: readiness ? {
      ...readinessChecks({
        ...readiness,
        fetch: readiness.fetch ?? transport.fetch,
        apiKey: config.apiKey,
        environment: config.environment,
        store: rest.store,
        resolvesPrices: !!resolvePrices
      }),
      ...rest.healthChecks
    } : rest.healthChecks
  });
  return { billing, config, problems, enforce, transport, ...products ? { products } : {} };
}
function storedOwnership(store) {
  return {
    async resolve() {
      const ids = await store.getOwnedIds();
      if (ids.priceIds.length === 0 && ids.productIds.length === 0) {
        throw new Error("paddle-kit: no owned price or product ids in the store yet: run the recovery job (or syncOwnership) once");
      }
      return ids;
    }
  };
}
export {
  billingFromEnv,
  defineProducts,
  priceIdOf,
  priceIds,
  readBillingEnv,
  readinessChecks
};
