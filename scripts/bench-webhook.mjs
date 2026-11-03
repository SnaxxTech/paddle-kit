// Webhook latency on real Postgres, end to end: signature check, event ledger, onTransaction with createFulfilment
// (grant + outbox enqueue in one SQL transaction). Paddle waits 5 s for a 2xx before it retries.
// Cold = a fresh Node process per sample (module import, pool connect, first request); warm = one process.
// Also counts SQL round trips per webhook, so the numbers can be projected onto a networked database (Neon).
// Needs `npm run build`, `pg` and `embedded-postgres` (or PADDLE_KIT_PG_URL). Run: node scripts/bench-webhook.mjs
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const t0 = performance.now();
const SECRET = 'pdl_ntfset_bench';
const fixture = JSON.parse(readFileSync(new URL('../tests/fixtures/transaction.completed.json', import.meta.url), 'utf8'));
const event = (i) => ({ ...fixture, event_id: `evt_b_${process.pid}_${i}`, occurred_at: new Date().toISOString(),
  data: { ...fixture.data, id: `txn_b_${process.pid}_${i}`, subscription_id: null, custom_data: { userId: `u_${process.pid}_${i}` } } }); // a one-time purchase: the path fulfilment runs

async function app(url, schema) {
  const { default: pg } = await import('pg');
  const { createBilling } = await import('../dist/core/index.js');
  const { postgresStore } = await import('../dist/postgres/index.js');
  const { createFulfilment, enqueue } = await import('../dist/fulfil/index.js');
  const pool = new pg.Pool({ connectionString: url, max: 10, options: `-c search_path=${schema}` });
  let trips = 0;
  const query = (t, p) => { trips++; return pool.query(t, p); };
  const db = { async transaction(fn) {
    const c = await pool.connect();
    const q = { query: (t, p) => { trips++; return c.query(t, p); } };
    try { await q.query('BEGIN'); const out = await fn(q); await q.query('COMMIT'); return out; }
    catch (e) { await q.query('ROLLBACK'); throw e; } finally { c.release(); }
  } };
  const hooks = createFulfilment(db, {
    orderOf: (tx) => ({ userId: tx.customData.userId, grants: { credits: 5 } }),
    async grant(q, f) {
      await q.query('INSERT INTO accounts (user_id, credits) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET credits = accounts.credits + $2', [f.userId, f.grants.credits]);
      await enqueue(q, { id: `${f.transactionId}:receipt`, kind: 'receipt', payload: { userId: f.userId } });
    },
    async revoke() { return 0; }, async restore() {},
  });
  const billing = createBilling({ environment: 'sandbox', webhookSecret: SECRET, entitlements: {}, owns: () => true, log: () => {},
    store: postgresStore({ query }), ...hooks });
  const send = async (e) => {
    const body = JSON.stringify(e);
    const ts = Math.floor(Date.now() / 1000);
    const sig = `ts=${ts};h1=${createHmac('sha256', SECRET).update(`${ts}:${body}`).digest('hex')}`;
    const before = trips;
    const start = performance.now();
    const r = await billing.handleWebhook(new Request('https://app.test/api/paddle', { method: 'POST', headers: { 'paddle-signature': sig }, body }));
    const ms = performance.now() - start;
    if (r.status !== 200) throw new Error(`status ${r.status}: ${await r.text()}`);
    return { ms, trips: trips - before };
  };
  return { send, pool };
}

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const stats = (xs) => `n=${xs.length} p50=${pct(xs, 50).toFixed(1)} p95=${pct(xs, 95).toFixed(1)} max=${Math.max(...xs).toFixed(1)} ms`;

if (process.argv[2] === 'cold') {
  // One cold sample: everything from process start (minus Node's own boot) to the first webhook's response.
  const { send, pool } = await app(process.env.URL, process.env.SCHEMA);
  const ready = performance.now();
  const r = await send(event(0));
  process.stdout.write(JSON.stringify({ setupMs: ready - t0, firstMs: r.ms, totalMs: performance.now() - t0, trips: r.trips }));
  await pool.end();
} else {
  const COLD = Number(process.env.COLD ?? 20);
  const WARM = Number(process.env.WARM ?? 500);
  let url = process.env.PADDLE_KIT_PG_URL;
  let stop = async () => {};
  if (!url) {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const dir = mkdtempSync(join(tmpdir(), 'paddle-kit-bench-'));
    const port = 55_000 + Math.floor(Math.random() * 1000);
    const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => {} });
    await server.initialise(); await server.start();
    url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
    stop = async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); };
  }
  const { default: pg } = await import('pg');
  const { MIGRATIONS } = await import('../dist/postgres/index.js');
  const schema = `bench_${Date.now()}`;
  const admin = new pg.Pool({ connectionString: url, max: 1, options: `-c search_path=${schema}` });
  await admin.query(`CREATE SCHEMA ${schema}`);
  for (const m of MIGRATIONS) await admin.query(m.sql);
  await admin.query('CREATE TABLE accounts (user_id text PRIMARY KEY, credits int NOT NULL)');
  const { rows: [v] } = await admin.query('SELECT version() AS v');
  console.log(`server: ${v.v.split(',')[0]} | node ${process.version} | ${process.env.PADDLE_KIT_PG_URL ? 'PADDLE_KIT_PG_URL' : 'embedded-postgres, localhost'}`);

  const cold = [];
  for (let i = 0; i < COLD; i++) {
    const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname, 'cold'], { env: { ...process.env, URL: url, SCHEMA: schema }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`cold sample ${i} failed: ${r.stderr}`);
    cold.push(JSON.parse(r.stdout));
  }
  const { send, pool } = await app(url, schema);
  for (let i = 0; i < 20; i++) await send(event(`w${i}`)); // warm-up, not counted
  const warm = [];
  for (let i = 0; i < WARM; i++) warm.push(await send(event(i)));
  const conc = [];
  let next = 0;
  await Promise.all(Array.from({ length: 10 }, async () => { while (next < WARM) conc.push((await send(event(`c${next++}`))).ms); }));
  const { rows: [counts] } = await pool.query(
    `SELECT (SELECT count(*)::int FROM paddle_outbox) AS outbox, (SELECT count(*)::int FROM paddle_fulfilments) AS fulfilments, (SELECT count(*)::int FROM accounts) AS accounts`);
  await pool.end(); await admin.end(); await stop();

  const expected = COLD + 20 + 2 * WARM;
  console.log(`rows: outbox ${counts.outbox}, fulfilments ${counts.fulfilments}, accounts ${counts.accounts} (expected ${expected} each)`);
  console.log(`cold setup (import + pool):  ${stats(cold.map((c) => c.setupMs))}`);
  console.log(`cold first webhook:          ${stats(cold.map((c) => c.firstMs))}`);
  console.log(`cold total:                  ${stats(cold.map((c) => c.totalMs))}`);
  console.log(`warm sequential:             ${stats(warm.map((w) => w.ms))}`);
  console.log(`warm concurrency 10:         ${stats(conc)}`);
  const trips = warm.map((w) => w.trips);
  console.log(`SQL round trips per webhook: min ${Math.min(...trips)} max ${Math.max(...trips)} (cold first: ${cold[0].trips})`);
  if (counts.outbox !== expected || counts.fulfilments !== expected) process.exitCode = 1;
}
