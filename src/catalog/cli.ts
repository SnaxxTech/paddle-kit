#!/usr/bin/env node
// paddle-kit-catalog --catalog paddle.catalog.json [--webhook-url https://…] [--env-file .env.local] [--teardown] [--live]
//                    [--host vercel] [--show-secrets]
// The API key comes from PADDLE_API_KEY (environment first, then the env file). Never printed.
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CatalogError, PaddleError, readCatalogFile, readEnvFile, redactSecrets, syncCatalog } from './index';
import { version } from '../../package.json';

export interface CliArgs {
  catalog: string;
  webhookUrl?: string;
  envFile: string;
  teardown: boolean;
  live: boolean;
  host?: 'vercel';
  showSecrets: boolean;
  help: boolean;
}

export const USAGE = `Usage: paddle-kit-catalog [options]

  --catalog <path>       catalog JSON (default: paddle.catalog.json)
  --webhook-url <url>    full https URL Paddle posts to; also creates the destination and a client token
  --env-file <path>      env file to read PADDLE_API_KEY from and write results to (default: .env.local)
  --teardown             archive the prices/product this tool created and deactivate its destination
  --live                 allow a live (pdl_live_) key; default refuses anything but a sandbox key
  --host vercel          also print the \`vercel env add\` commands for the host variables (never runs them)
  --show-secrets         print the webhook secret in the host block instead of hiding it
  --help                 show this text
`;

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { catalog: 'paddle.catalog.json', envFile: '.env.local', teardown: false, live: false, showSecrets: false, help: false };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new CatalogError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--teardown') args.teardown = true;
    else if (a === '--live') args.live = true;
    else if (a === '--show-secrets') args.showSecrets = true;
    else if (a === '--host') {
      const host = value(i++, a);
      if (host !== 'vercel') throw new CatalogError(`unknown --host "${host}" (supported: vercel)`);
      args.host = host;
    }
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--catalog') args.catalog = value(i++, a);
    else if (a === '--env-file') args.envFile = value(i++, a);
    else if (a === '--webhook-url') args.webhookUrl = value(i++, a); // syncCatalog requires https, before any request
    else throw new CatalogError(`unknown option: ${a}`);
  }
  return args;
}

// The variables a deployed app reads that this CLI writes. Only the webhook secret is secret: the client token ships to the browser.
const HOST_KEYS = ['PADDLE_ENV', 'PADDLE_PRICES', 'PADDLE_NOTIFICATION_WEBHOOK_SECRET', 'NEXT_PUBLIC_PADDLE_CLIENT_TOKEN'] as const;
const SECRET_KEYS: readonly string[] = ['PADDLE_NOTIFICATION_WEBHOOK_SECRET'];
const shellQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/**
 * The copy-paste block for the host (and, with `host: 'vercel'`, the `vercel env add` commands). A secret is a comment
 * with only its last 4 characters unless `showSecrets`, so a pasted block can never set a placeholder as the secret.
 */
export function hostEnvBlock(env: Record<string, string>, opts: { envFile: string; live: boolean; host?: 'vercel'; showSecrets: boolean }): string[] {
  const targets = opts.live ? ['production'] : ['preview', 'development'];
  const lines = [
    `Set these on the host too, not only in ${opts.envFile} (${opts.live ? 'live: Production' : 'sandbox: Preview and Development'}). A deployed app reads only the host's variables:`,
  ];
  const commands: string[] = [];
  for (const key of HOST_KEYS) {
    const value = env[key];
    if (!value) {
      lines.push(`# ${key} is not set yet${key === 'PADDLE_ENV' || key === 'PADDLE_PRICES' ? '' : ': run again with --webhook-url'}`);
      continue;
    }
    const hidden = SECRET_KEYS.includes(key) && !opts.showSecrets;
    lines.push(hidden ? `# ${key}=<secret${value.length >= 16 ? ` ending in ${value.slice(-4)}` : ''}: copy it from ${opts.envFile}, or run with --show-secrets>` : `${key}=${value}`);
    for (const target of targets) {
      commands.push(hidden ? `vercel env add ${key} ${target}   # asks for the value: copy it from ${opts.envFile}` : `printf '%s' ${shellQuote(value)} | vercel env add ${key} ${target}`);
    }
  }
  lines.push('# Also set these if the app uses them: PADDLE_API_KEY (reconcile, getPrice), PADDLE_HEALTH_TOKEN (health route, paddle-kit-doctor), BILLING_LAUNCH_AT, BILLING_ENFORCE.');
  lines.push('# Redeploy after a change: NEXT_PUBLIC_ variables are read at build time.');
  if (opts.host === 'vercel') lines.push('', 'Vercel (not run; check each command before you run it):', ...commands);
  return lines;
}

/** One line when the CLI runs from the npx cache in a folder that is not an app depending on paddle-kit, else null. */
export function npxHint(scriptPath: string, cwd: string): string | null {
  if (!/[\\/]_npx[\\/]/.test(scriptPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    if (pkg?.dependencies?.['paddle-kit'] || pkg?.devDependencies?.['paddle-kit']) return null;
  } catch {
    /* no or unreadable package.json: not an app */
  }
  return `Note: paddle-kit runs from the npx cache, and ${cwd} is not an app that depends on it (env files land here). In your app: npm i github:SnaxxTech/paddle-kit#v${version}, then npx paddle-kit-catalog.`;
}

export async function main(argv = process.argv.slice(2), scriptPath = process.argv[1] ?? ''): Promise<number> {
  let apiKey: string | undefined;
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
    // Not through redactSecrets: the block must show the client token, and it never holds the API key.
    if (!args.teardown) console.log(['', ...hostEnvBlock(readEnvFile(envFile), { envFile: args.envFile, live: args.live, host: args.host, showSecrets: args.showSecrets })].join('\n'));
    return 0;
  } catch (error) {
    // Only our own error classes carry messages that are safe to print.
    const safe = error instanceof CatalogError || error instanceof PaddleError;
    console.error(safe ? redactSecrets(error.message, apiKey ? [apiKey] : []) : 'paddle-kit-catalog failed');
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
