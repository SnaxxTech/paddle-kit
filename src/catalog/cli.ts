#!/usr/bin/env node
// paddle-kit-catalog --catalog paddle.catalog.json [--webhook-url https://…] [--env-file .env.local] [--teardown] [--live]
// The API key comes from PADDLE_API_KEY (environment first, then the env file). Never printed.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CatalogError, PaddleError, readCatalogFile, readEnvFile, syncCatalog } from './index';

export interface CliArgs {
  catalog: string;
  webhookUrl?: string;
  envFile: string;
  teardown: boolean;
  live: boolean;
  help: boolean;
}

export const USAGE = `Usage: paddle-kit-catalog [options]

  --catalog <path>       catalog JSON (default: paddle.catalog.json)
  --webhook-url <url>    full https URL Paddle posts to; also creates the destination and a client token
  --env-file <path>      env file to read PADDLE_API_KEY from and write results to (default: .env.local)
  --teardown             archive the prices/product this tool created and deactivate its destination
  --live                 allow a live (pdl_live_) key; default refuses anything but a sandbox key
  --help                 show this text
`;

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { catalog: 'paddle.catalog.json', envFile: '.env.local', teardown: false, live: false, help: false };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new CatalogError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--teardown') args.teardown = true;
    else if (a === '--live') args.live = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--catalog') args.catalog = value(i++, a);
    else if (a === '--env-file') args.envFile = value(i++, a);
    else if (a === '--webhook-url') {
      const url = value(i++, a);
      if (!/^https:\/\/[^\s]+$/.test(url)) throw new CatalogError('--webhook-url needs an https URL');
      args.webhookUrl = url;
    } else throw new CatalogError(`unknown option: ${a}`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(USAGE);
      return 0;
    }
    const cwd = process.cwd();
    const envFile = path.resolve(cwd, args.envFile);
    const apiKey = process.env.PADDLE_API_KEY || readEnvFile(envFile).PADDLE_API_KEY;
    if (!apiKey) throw new PaddleError(`PADDLE_API_KEY not found in the environment or ${args.envFile}`);
    const catalog = readCatalogFile(path.resolve(cwd, args.catalog));
    await syncCatalog({ apiKey, catalog, webhookUrl: args.webhookUrl, envFile, teardown: args.teardown, live: args.live });
    return 0;
  } catch (error) {
    // Only our own error classes carry messages that are safe to print.
    console.error(error instanceof CatalogError || error instanceof PaddleError ? error.message : 'paddle-kit-catalog failed');
    return 1;
  }
}

// Run only as the executable (also through the npm bin symlink), never when imported by tests.
const isEntry = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isEntry) process.exitCode = await main();
