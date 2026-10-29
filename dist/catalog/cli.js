#!/usr/bin/env node
import {
  CatalogError,
  readCatalogFile,
  readEnvFile,
  syncCatalog
} from "../chunk-5FP6TYXF.js";
import {
  version
} from "../chunk-OXXMFIPN.js";
import {
  PaddleError,
  redactSecrets
} from "../chunk-EMR6PZ3J.js";
import "../chunk-UYGU5JF5.js";

// src/catalog/cli.ts
import { readFileSync, realpathSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
var USAGE = `Usage: paddle-kit-catalog [options]

  --catalog <path>       catalog JSON (default: paddle.catalog.json)
  --webhook-url <url>    full https URL Paddle posts to; also creates the destination and a client token
  --env-file <path>      env file to read PADDLE_API_KEY from and write results to (default: .env.local)
  --teardown             archive the prices/product this tool created and deactivate its destination
  --live                 allow a live (pdl_live_) key; default refuses anything but a sandbox key
  --host vercel          also print the \`vercel env add\` commands for the host variables (never runs them)
  --show-secrets         print the webhook secret in the host block instead of hiding it
  --help                 show this text
`;
function parseArgs(argv) {
  const args = { catalog: "paddle.catalog.json", envFile: ".env.local", teardown: false, live: false, showSecrets: false, help: false };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === void 0 || v.startsWith("--")) throw new CatalogError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--teardown") args.teardown = true;
    else if (a === "--live") args.live = true;
    else if (a === "--show-secrets") args.showSecrets = true;
    else if (a === "--host") {
      const host = value(i++, a);
      if (host !== "vercel") throw new CatalogError(`unknown --host "${host}" (supported: vercel)`);
      args.host = host;
    } else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--catalog") args.catalog = value(i++, a);
    else if (a === "--env-file") args.envFile = value(i++, a);
    else if (a === "--webhook-url") args.webhookUrl = value(i++, a);
    else throw new CatalogError(`unknown option: ${a}`);
  }
  return args;
}
var HOST_KEYS = ["PADDLE_ENV", "PADDLE_PRICES", "PADDLE_NOTIFICATION_WEBHOOK_SECRET", "NEXT_PUBLIC_PADDLE_CLIENT_TOKEN"];
var SECRET_KEYS = ["PADDLE_NOTIFICATION_WEBHOOK_SECRET"];
var shellQuote = (v) => `'${v.replace(/'/g, `'\\''`)}'`;
function hostEnvBlock(env, opts) {
  const targets = opts.live ? ["production"] : ["preview", "development"];
  const lines = [
    `Set these on the host too, not only in ${opts.envFile} (${opts.live ? "live: Production" : "sandbox: Preview and Development"}). A deployed app reads only the host's variables:`
  ];
  const commands = [];
  for (const key of HOST_KEYS) {
    const value = env[key];
    if (!value) {
      lines.push(`# ${key} is not set yet${key === "PADDLE_ENV" || key === "PADDLE_PRICES" ? "" : ": run again with --webhook-url"}`);
      continue;
    }
    const hidden = SECRET_KEYS.includes(key) && !opts.showSecrets;
    lines.push(hidden ? `# ${key}=<secret${value.length >= 16 ? ` ending in ${value.slice(-4)}` : ""}: copy it from ${opts.envFile}, or run with --show-secrets>` : `${key}=${value}`);
    for (const target of targets) {
      commands.push(hidden ? `vercel env add ${key} ${target}   # asks for the value: copy it from ${opts.envFile}` : `printf '%s' ${shellQuote(value)} | vercel env add ${key} ${target}`);
    }
  }
  lines.push("# Also set these if the app uses them: PADDLE_API_KEY (reconcile, getPrice), PADDLE_HEALTH_TOKEN (health route, paddle-kit-doctor), BILLING_LAUNCH_AT, BILLING_ENFORCE.");
  lines.push("# Redeploy after a change: NEXT_PUBLIC_ variables are read at build time.");
  if (opts.host === "vercel") lines.push("", "Vercel (not run; check each command before you run it):", ...commands);
  return lines;
}
function npxHint(scriptPath, cwd) {
  if (!/[\\/]_npx[\\/]/.test(scriptPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
    if (pkg?.dependencies?.["paddle-kit"] || pkg?.devDependencies?.["paddle-kit"]) return null;
  } catch {
  }
  return `Note: paddle-kit runs from the npx cache, and ${cwd} is not an app that depends on it (env files land here). In your app: npm i github:SnaxxTech/paddle-kit#v${version}, then npx paddle-kit-catalog.`;
}
async function main(argv = process.argv.slice(2), scriptPath = process.argv[1] ?? "") {
  let apiKey;
  try {
    const hint = npxHint(scriptPath, process.cwd());
    if (hint) console.error(hint);
    const args = parseArgs(argv);
    if (args.help) {
      console.log(USAGE);
      return 0;
    }
    const cwd = process.cwd();
    const envFile = path.resolve(cwd, args.envFile);
    apiKey = process.env.PADDLE_API_KEY || readEnvFile(envFile).PADDLE_API_KEY;
    if (!apiKey) throw new PaddleError(`PADDLE_API_KEY not found in the environment or ${args.envFile}`);
    const catalog = readCatalogFile(path.resolve(cwd, args.catalog));
    await syncCatalog({ apiKey, catalog, webhookUrl: args.webhookUrl, envFile, teardown: args.teardown, live: args.live });
    if (!args.teardown) console.log(["", ...hostEnvBlock(readEnvFile(envFile), { envFile: args.envFile, live: args.live, host: args.host, showSecrets: args.showSecrets })].join("\n"));
    return 0;
  } catch (error) {
    const safe = error instanceof CatalogError || error instanceof PaddleError;
    console.error(safe ? redactSecrets(error.message, apiKey ? [apiKey] : []) : "paddle-kit-catalog failed");
    return 1;
  }
}
var isEntry = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isEntry) process.exitCode = await main();
export {
  USAGE,
  hostEnvBlock,
  main,
  npxHint,
  parseArgs
};
