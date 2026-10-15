import { c as Store } from '../types-BYpRwb7Q.js';

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
