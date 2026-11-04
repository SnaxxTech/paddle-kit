// The starters' lib/db.ts inside real workerd (Cloudflare Workers' runtime, through Miniflare), on a real Postgres
// (since v0.9.2). Workers forbids using a socket opened during one request from another: a postgres-js client kept at
// module scope works once, then fails with "Cannot perform I/O on behalf of a different request". Three requests,
// each with a query and a transaction, must all work.
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { afterAll, describe, expect, it } from 'vitest';
import { realPostgres } from './helpers/real-pg';

const live = await realPostgres('workerd database suite');
afterAll(async () => { await live?.stop(); });
const root = fileURLToPath(new URL('..', import.meta.url));

describe.skipIf(!live)('starters lib/db.ts in real workerd', () => {
  for (const starter of ['subscription', 'unlock', 'credits']) {
    it(`${starter}: every request can query and run a transaction`, async () => {
      const worker = `
import { db } from './examples/${starter}/lib/db.ts';
export default { async fetch() {
  try {
    const a = (await db.query('SELECT $1::int AS n', [1])).rows[0].n;
    const b = await db.transaction(async (q) => (await q.query('SELECT 2 AS n')).rows[0].n);
    return Response.json({ a, b });
  } catch (e) { return Response.json({ error: String(e && e.message).slice(0, 120) }); }
} };`;
      const out = await build({
        stdin: { contents: worker, resolveDir: root, loader: 'ts' }, bundle: true, format: 'esm', platform: 'neutral',
        conditions: ['workerd', 'worker'], mainFields: ['module', 'main'], external: ['cloudflare:sockets', 'node:*'],
        alias: { 'paddle-kit/db': `${root}src/db/index.ts` }, write: false, logLevel: 'error',
      });
      // process.env carries the Worker's vars with nodejs_compat from this compatibility date on.
      const mf = new Miniflare({ modules: true, script: out.outputFiles[0]!.text, compatibilityDate: '2025-04-01',
        compatibilityFlags: ['nodejs_compat'], bindings: { DATABASE_URL: live!.url } });
      try {
        const answers = [];
        for (let i = 0; i < 3; i++) answers.push(await (await mf.dispatchFetch('http://localhost/')).json());
        expect(answers).toEqual([{ a: 1, b: 2 }, { a: 1, b: 2 }, { a: 1, b: 2 }]);
      } finally {
        await mf.dispose();
      }
    }, 60_000);
  }
});
