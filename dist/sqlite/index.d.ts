import { c as Store } from '../types-BYpRwb7Q.js';

/** The subset of better-sqlite3 this store uses; any compatible driver works. */
interface SqliteStatement {
    run(...params: unknown[]): {
        changes: number;
    };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
    prepare(sql: string): SqliteStatement;
    exec(sql: string): unknown;
}
declare const SQLITE_MIGRATIONS: ReadonlyArray<{
    name: string;
    sql: string;
}>;
declare function sqliteStore({ db }: {
    db: SqliteDatabase;
}): Store;

export { SQLITE_MIGRATIONS, type SqliteDatabase, type SqliteStatement, sqliteStore };
