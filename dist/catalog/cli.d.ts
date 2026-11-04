#!/usr/bin/env node
interface CliArgs {
    catalog: string;
    webhookUrl?: string;
    envFile: string;
    teardown: boolean;
    live: boolean;
    host?: 'vercel';
    showSecrets: boolean;
    help: boolean;
}
declare const USAGE = "Usage: paddle-kit-catalog [options]\n\n  --catalog <path>       catalog JSON (default: paddle.catalog.json)\n  --webhook-url <url>    full https URL Paddle posts to; also creates the destination and a client token\n  --env-file <path>      env file to read PADDLE_API_KEY from and write results to (default: .env.local)\n  --teardown             archive the prices/product this tool created and deactivate its destination\n  --live                 allow a live (pdl_live_) key; default refuses anything but a sandbox key\n  --host vercel          also print the `vercel env add` commands for the host variables (never runs them)\n  --show-secrets         print the webhook secret in the host block instead of hiding it\n  --help                 show this text\n";
declare function parseArgs(argv: string[]): CliArgs;
/**
 * The copy-paste block for the host (and, with `host: 'vercel'`, the `vercel env add` commands). A secret is a comment
 * with only its last 4 characters unless `showSecrets`, so a pasted block can never set a placeholder as the secret.
 */
declare function hostEnvBlock(env: Record<string, string>, opts: {
    envFile: string;
    live: boolean;
    host?: 'vercel';
    showSecrets: boolean;
}): string[];
/** One line when the CLI runs from the npx cache in a folder that is not an app depending on paddle-kit, else null. */
declare function npxHint(scriptPath: string, cwd: string): string | null;
declare function main(argv?: string[], scriptPath?: string): Promise<number>;

export { USAGE, hostEnvBlock, main, npxHint, parseArgs };
export type { CliArgs };
