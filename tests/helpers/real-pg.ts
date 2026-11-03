import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A real Postgres server: PADDLE_KIT_PG_URL, or `embedded-postgres`. Null (with a loud SKIP line) when neither works. */
export async function realPostgres(suite: string): Promise<{ url: string; stop: () => Promise<void> } | null> {
  let skip = '';
  if (process.env.PADDLE_KIT_PG_URL) return { url: process.env.PADDLE_KIT_PG_URL, stop: async () => {} };
  const mod = await import('embedded-postgres' as string).catch(() => null);
  if (mod) {
    const dir = mkdtempSync(join(tmpdir(), 'paddle-kit-pg-'));
    const port = 56_000 + Math.floor(Math.random() * 1000);
    const server = new mod.default({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => {} });
    try {
      await server.initialise();
      await server.start();
      return { url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`, stop: async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); } };
    } catch (e) { skip = `embedded-postgres failed: ${(e as Error).message}`; }
  } else skip = 'no PADDLE_KIT_PG_URL and `embedded-postgres` is not installed';
  if (process.env.PADDLE_KIT_REQUIRE_PG === '1') throw new Error(`PADDLE_KIT_REQUIRE_PG=1 but ${suite} cannot run: ${skip}`);
  process.stderr.write(`\n######## SKIP: ${suite} NOT RUN (${skip}). ########\n\n`);
  return null;
}
