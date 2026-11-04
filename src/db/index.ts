// Database adapters (since v0.9.0): one `{ query, transaction }` per Postgres client, for `postgresStore({ query })`
// and `createFulfilment(db, …)`. Duck-typed, no driver import: edge-safe, and the app keeps its own client.
// better-sqlite3 needs none: `sqliteStore(db)` takes the Database (fulfilment is Postgres-only).
import type { SqlDb, SqlTx } from '../fulfil';

export type { SqlDb, SqlTx };
/** A query function and a transaction runner on one client. */
export interface Db extends SqlDb {
  query: SqlTx['query'];
}

type Rows = { rows: any[] };

/**
 * `pg`'s Pool and `@neondatabase/serverless`'s Pool (WebSocket; same API). A transaction holds one pooled client from
 * BEGIN to COMMIT. Neon's HTTP `neon()` function has no interactive transactions: use its Pool.
 */
export function fromPg(pool: {
  query(text: string, params?: unknown[]): Promise<Rows>;
  connect(): Promise<{ query(text: string, params?: unknown[]): Promise<Rows>; release(destroy?: boolean | Error): void }>;
}): Db {
  return {
    query: (text, params) => pool.query(text, params),
    async transaction(fn) {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query('BEGIN');
        const out = await fn({ query: (text, params) => client.query(text, params) });
        await client.query('COMMIT');
        return out;
      } catch (error) {
        // A failed ROLLBACK means the connection is unusable: destroy it instead of returning it to the pool.
        await client.query('ROLLBACK').catch(() => { broken = true; });
        throw error;
      } finally {
        client.release(broken);
      }
    },
  };
}

type PostgresJsSql = { unsafe(text: string, params?: any[]): PromiseLike<any[]> };
type PostgresJsClient = PostgresJsSql & { begin<T>(fn: (tx: PostgresJsSql) => Promise<T>): Promise<unknown> };

const on = (s: PostgresJsSql): SqlTx['query'] => async (text, params) => ({ rows: [...(await s.unsafe(text, (params ?? []) as any[]))] });

/** postgres-js (`postgres(url)`): `$n` queries through `sql.unsafe`, transactions through `sql.begin`. */
export function fromPostgresJs(sql: PostgresJsClient): Db {
  return {
    query: on(sql),
    transaction: async (fn) => (await sql.begin((tx) => fn({ query: on(tx) }))) as never,
  };
}

/**
 * postgres-js on Cloudflare Workers (since v0.9.2). A socket cannot be used by a request other than the one that
 * opened it, so a client kept at module scope fails from the second request on ("Cannot perform I/O on behalf of a
 * different request"). Here each query, and each whole transaction, opens a client from `make()` and ends it.
 * Pair it with Hyperdrive, whose pool makes each connect cheap; straight to Neon, every call is a new connection.
 */
export function fromPostgresJsPerCall(make: () => PostgresJsClient & { end(o?: { timeout?: number }): Promise<void> }): Db {
  const scoped = async <T>(fn: (sql: PostgresJsClient) => Promise<T>): Promise<T> => {
    const sql = make();
    try {
      return await fn(sql);
    } finally {
      await sql.end({ timeout: 5 });
    }
  };
  return {
    query: (text, params) => scoped((sql) => on(sql)(text, params)),
    transaction: (fn) => scoped(async (sql) => (await sql.begin((tx) => fn({ query: on(tx) }))) as never),
  };
}

/** PGlite (`new PGlite()`, local development and tests). */
export function fromPglite(db: {
  query(text: string, params?: unknown[]): Promise<Rows>;
  transaction<T>(fn: (tx: { query(text: string, params?: unknown[]): Promise<Rows> }) => Promise<T>): Promise<T>;
}): Db {
  return {
    query: (text, params) => db.query(text, params),
    transaction: (fn) => db.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) })),
  };
}
