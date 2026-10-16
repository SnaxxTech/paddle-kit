#!/usr/bin/env node
interface CliArgs {
    catalog: string;
    webhookUrl?: string;
    envFile: string;
    teardown: boolean;
    live: boolean;
    help: boolean;
}
declare const USAGE = "Usage: paddle-kit-catalog [options]\n\n  --catalog <path>       catalog JSON (default: paddle.catalog.json)\n  --webhook-url <url>    full https URL Paddle posts to; also creates the destination and a client token\n  --env-file <path>      env file to read PADDLE_API_KEY from and write results to (default: .env.local)\n  --teardown             archive the prices/product this tool created and deactivate its destination\n  --live                 allow a live (pdl_live_) key; default refuses anything but a sandbox key\n  --help                 show this text\n";
declare function parseArgs(argv: string[]): CliArgs;
declare function main(argv?: string[]): Promise<number>;

export { type CliArgs, USAGE, main, parseArgs };
