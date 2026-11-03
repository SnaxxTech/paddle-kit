import { Store } from '../core/index.js';

declare const MIGRATIONS: ReadonlyArray<{
    name: string;
    sql: string;
}>;

type SqlQuery = (text: string, params?: unknown[]) => Promise<{
    rows: Record<string, unknown>[];
}>;
declare function postgresStore({ query }: {
    query: SqlQuery;
}): Store;

export { MIGRATIONS, postgresStore };
export type { SqlQuery };
