import { SqlDb, SqlTx } from '../fulfil/index.js';
import '../billing-CurmP9JV.js';
import '../types-CtFsI0jC.js';
import '../paddle-api-CrEnAa2Z.js';

/** A query function and a transaction runner on one client. */
interface Db extends SqlDb {
    query: SqlTx['query'];
}
type Rows = {
    rows: any[];
};
/**
 * `pg`'s Pool and `@neondatabase/serverless`'s Pool (WebSocket; same API). A transaction holds one pooled client from
 * BEGIN to COMMIT. Neon's HTTP `neon()` function has no interactive transactions: use its Pool.
 */
declare function fromPg(pool: {
    query(text: string, params?: unknown[]): Promise<Rows>;
    connect(): Promise<{
        query(text: string, params?: unknown[]): Promise<Rows>;
        release(destroy?: boolean | Error): void;
    }>;
}): Db;
type PostgresJsSql = {
    unsafe(text: string, params?: any[]): PromiseLike<any[]>;
};
type PostgresJsClient = PostgresJsSql & {
    begin<T>(fn: (tx: PostgresJsSql) => Promise<T>): Promise<unknown>;
};
/** postgres-js (`postgres(url)`): `$n` queries through `sql.unsafe`, transactions through `sql.begin`. */
declare function fromPostgresJs(sql: PostgresJsClient): Db;
/**
 * postgres-js on Cloudflare Workers (since v0.9.2). A socket cannot be used by a request other than the one that
 * opened it, so a client kept at module scope fails from the second request on ("Cannot perform I/O on behalf of a
 * different request"). Here each query, and each whole transaction, opens a client from `make()` and ends it.
 * Pair it with Hyperdrive, whose pool makes each connect cheap; straight to Neon, every call is a new connection.
 */
declare function fromPostgresJsPerCall(make: () => PostgresJsClient & {
    end(o?: {
        timeout?: number;
    }): Promise<void>;
}): Db;
/** PGlite (`new PGlite()`, local development and tests). */
declare function fromPglite(db: {
    query(text: string, params?: unknown[]): Promise<Rows>;
    transaction<T>(fn: (tx: {
        query(text: string, params?: unknown[]): Promise<Rows>;
    }) => Promise<T>): Promise<T>;
}): Db;

export { SqlDb, SqlTx, fromPg, fromPglite, fromPostgresJs, fromPostgresJsPerCall };
export type { Db };
