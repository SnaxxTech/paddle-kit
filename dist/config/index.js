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
  if (!webhookSecret?.trim()) problems.push("PADDLE_NOTIFICATION_WEBHOOK_SECRET is missing");
  else if (webhookSecret !== webhookSecret.trim()) problems.push("PADDLE_NOTIFICATION_WEBHOOK_SECRET has leading or trailing whitespace");
  let prices = null;
  if (!env.PADDLE_PRICES) {
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
  const apiKey = env.PADDLE_API_KEY || void 0;
  if (apiKey && envValid && !apiKey.startsWith(environment === "production" ? "pdl_live_" : "pdl_sdbx_"))
    problems.push("PADDLE_API_KEY does not match PADDLE_ENV (pdl_sdbx_ = sandbox, pdl_live_ = production)");
  if (problems.length > 0 || !nonEmpty(webhookSecret) || !prices) return { config: null, problems };
  const config = {
    environment,
    webhookSecret,
    prices,
    clientToken,
    launchAt,
    enforce: env.BILLING_ENFORCE === "1"
  };
  if (env.PADDLE_HEALTH_TOKEN) config.healthToken = env.PADDLE_HEALTH_TOKEN;
  if (apiKey) config.apiKey = apiKey;
  return { config, problems };
}
export {
  readBillingEnv
};
