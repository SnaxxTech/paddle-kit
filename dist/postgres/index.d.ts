import { S as Store } from '../types-BgyCdvFl.js';

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

export { MIGRATIONS, type SqlQuery, postgresStore };
