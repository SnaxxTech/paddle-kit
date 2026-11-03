// `npm run db:migrate` runs this before a deploy: the kit's tables (paddle_*), then the app's own. Every statement is
// CREATE … IF NOT EXISTS, so running it again changes nothing.
import { MIGRATIONS } from 'paddle-kit/postgres';
import { db } from './db';

const APP_SQL: string[] = [
];

export async function migrate(): Promise<void> {
  for (const m of MIGRATIONS) for (const statement of m.sql.split(/;\s*\n/)) if (statement.trim()) await db.query(statement);
  for (const statement of APP_SQL) await db.query(statement);
}
