#!/usr/bin/env node
import {
  CatalogError,
  readCatalogFile,
  readEnvFile,
  syncCatalog
} from "../chunk-J2WUPMNX.js";
import {
  PaddleError,
  redactSecrets
} from "../chunk-U2MNQW4V.js";
import "../chunk-NSUHMBM5.js";

// src/catalog/cli.ts
import { realpathSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
var USAGE = `Usage: paddle-kit-catalog [options]

  --catalog <path>       catalog JSON (default: paddle.catalog.json)
  --webhook-url <url>    full https URL Paddle posts to; also creates the destination and a client token
  --env-file <path>      env file to read PADDLE_API_KEY from and write results to (default: .env.local)
  --teardown             archive the prices/product this tool created and deactivate its destination
  --live                 allow a live (pdl_live_) key; default refuses anything but a sandbox key
  --help                 show this text
`;
function parseArgs(argv) {
  const args = { catalog: "paddle.catalog.json", envFile: ".env.local", teardown: false, live: false, help: false };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === void 0 || v.startsWith("--")) throw new CatalogError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--teardown") args.teardown = true;
    else if (a === "--live") args.live = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--catalog") args.catalog = value(i++, a);
    else if (a === "--env-file") args.envFile = value(i++, a);
    else if (a === "--webhook-url") args.webhookUrl = value(i++, a);
    else throw new CatalogError(`unknown option: ${a}`);
  }
  return args;
}
async function main(argv = process.argv.slice(2)) {
  let apiKey;
  try {
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
  main,
  parseArgs
};
