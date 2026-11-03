// The app's Postgres client, one per server process. postgres-js runs on Node (Vercel) and on Cloudflare Workers.
// On Workers a socket cannot cross requests: create the client per request there (with Hyperdrive in front of Neon).
// Another client is one line: `fromPg(new Pool(…))` for pg or @neondatabase/serverless, `fromPglite(new PGlite())`.
import postgres from 'postgres';
import { fromPostgresJs } from 'paddle-kit/db';

export const db = fromPostgresJs(postgres(process.env.DATABASE_URL ?? '', { max: 5, prepare: false }));
