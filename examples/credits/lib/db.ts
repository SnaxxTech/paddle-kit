// The app's Postgres client. postgres-js runs on Node (Vercel) and on Cloudflare Workers. On Workers a socket cannot be
// used by a request other than the one that opened it, so there each query and transaction opens its own client
// (cheap behind Hyperdrive: set DATABASE_URL to its connection string). Elsewhere one pooled client serves the process.
// Another client is one line: `fromPg(new Pool(…))` for pg or @neondatabase/serverless, `fromPglite(new PGlite())`.
import postgres from 'postgres';
import { fromPostgresJs, fromPostgresJsPerCall } from 'paddle-kit/db';

const url = process.env.DATABASE_URL ?? '';
const onWorkers = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';

export const db = onWorkers
  ? fromPostgresJsPerCall(() => postgres(url, { max: 1, prepare: false, fetch_types: false }))
  : fromPostgresJs(postgres(url, { max: 5, prepare: false }));
