import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tgz = execFileSync('npm', ['pack', '--silent'], { encoding: 'utf8' }).trim().split('\n').at(-1);
const dir = mkdtempSync(join(tmpdir(), 'paddle-kit-smoke-'));
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'smoke', type: 'module', private: true }));
execFileSync('npm', ['i', '--silent', resolve(tgz), '@paddle/paddle-js', 'typescript@5.9.3', '@types/node'], { cwd: dir, stdio: 'inherit' });
const subpaths = ['core', 'memory', 'postgres', 'sqlite', 'next', 'client', 'reconcile', 'plan', 'config', 'catalog'];
const code = subpaths.map((p) => `await import('paddle-kit/${p}');`).join('\n') + "\nconsole.log('all subpaths import');";
// CommonJS-style resolvers (Playwright, tsx, Jest) resolve through the "default" condition.
const resolveCheck = subpaths.map((p) => `require.resolve('paddle-kit/${p}');`).join('\n') + "\nconsole.log('all subpaths resolve via require');";
writeFileSync(join(dir, 'check.mjs'), code);
execFileSync('node', ['check.mjs'], { cwd: dir, stdio: 'inherit' });
writeFileSync(join(dir, 'resolve.cjs'), resolveCheck + `
for (const gone of ['paddle-kit/hono', 'paddle-kit/express']) {
  try { require.resolve(gone); throw new Error(gone + ' still resolves'); } catch (e) { if (e.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw e; }
}
console.log('removed subpaths (hono, express) are gone');`);
execFileSync('node', ['resolve.cjs'], { cwd: dir, stdio: 'inherit' });

// Prove the published types resolve for NodeNext consumers.
writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: false, types: [] }, files: ['check.mts'] }));
writeFileSync(join(dir, 'check.mts'), `import type { Billing } from 'paddle-kit/core';
import { memoryStore } from 'paddle-kit/memory';
import { postgresStore } from 'paddle-kit/postgres';
import { sqliteStore } from 'paddle-kit/sqlite';
import { createNextRoute } from 'paddle-kit/next';
import { createCheckout } from 'paddle-kit/client';
import { reconcile } from 'paddle-kit/reconcile';
import { planOf, type Plan } from 'paddle-kit/plan';
import { readBillingEnv, type BillingEnv, type PriceMap } from 'paddle-kit/config';
import { syncCatalog, validateCatalog, type Catalog } from 'paddle-kit/catalog';
export type T = [Billing, typeof memoryStore, typeof postgresStore, typeof sqliteStore, typeof createNextRoute, typeof createCheckout, typeof reconcile, typeof planOf, Plan, typeof readBillingEnv, BillingEnv, PriceMap, typeof syncCatalog, typeof validateCatalog, Catalog];
`);
execFileSync('npx', ['tsc', '-p', '.'], { cwd: dir, stdio: 'inherit' });
console.log('types resolve under NodeNext');

// The bin must be linked, executable and runnable (--help exits 0 without touching the network).
const bin = join(dir, 'node_modules', '.bin', 'paddle-kit-catalog');
if (!existsSync(bin)) throw new Error('paddle-kit-catalog bin missing after install');
if ((statSync(resolve(dir, 'node_modules/paddle-kit/dist/catalog/cli.js')).mode & 0o111) === 0) throw new Error('catalog cli.js is not executable');
const help = execFileSync(bin, ['--help'], { cwd: dir, encoding: 'utf8' });
if (!help.includes('--webhook-url')) throw new Error('paddle-kit-catalog --help printed no usage');
console.log('paddle-kit-catalog bin runs');

// Behaviour through the installed package: signed webhooks with shared-seller filtering and the known flag.
writeFileSync(join(dir, 'webhook.mjs'), `
import { createHmac } from 'node:crypto';
import { createBilling } from 'paddle-kit/core';
import { memoryStore } from 'paddle-kit/memory';
const secret = 'pdl_ntfset_smoke';
const at = new Date().toISOString();
const txs = [];
const adjs = [];
const billing = createBilling({
  environment: 'sandbox', webhookSecret: secret, store: memoryStore(), entitlements: {}, log: () => {},
  owns: { priceIds: ['pri_ours'] },
  onTransaction: (tx) => { txs.push(tx.transactionId); },
  onAdjustment: (a, ctx) => { adjs.push([a.transactionId, ctx.known]); },
});
const send = (event) => {
  const body = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const h1 = createHmac('sha256', secret).update(ts + ':' + body).digest('hex');
  return billing.handleWebhook(new Request('https://smoke.test/', { method: 'POST', headers: { 'paddle-signature': 'ts=' + ts + ';h1=' + h1 }, body }));
};
const txn = (id, price, ev) => ({ event_id: ev, event_type: 'transaction.completed', occurred_at: at, data: { id, status: 'completed', items: [{ price: { id: price, product_id: 'pro_x' }, quantity: 1 }] } });
const adj = (txId, ev) => ({ event_id: ev, event_type: 'adjustment.created', occurred_at: at, data: { id: 'adj_' + ev, transaction_id: txId, action: 'refund', status: 'approved', type: 'full' } });
const statuses = [];
for (const e of [txn('txn_ours', 'pri_ours', 'e1'), txn('txn_theirs', 'pri_theirs', 'e2'), adj('txn_theirs', 'e3'), adj('txn_unseen', 'e4'), adj('txn_ours', 'e5')]) {
  statuses.push((await send(e)).status);
}
const got = JSON.stringify({ statuses, txs, adjs });
const want = JSON.stringify({ statuses: [200, 200, 200, 200, 200], txs: ['txn_ours'], adjs: [['txn_unseen', false], ['txn_ours', true]] });
if (got !== want) { console.error('webhook smoke failed: got ' + got + ', want ' + want); process.exit(1); }
console.log('signed webhooks through the tarball: other products filtered, unseen refund passed with known: false');
`);
execFileSync('node', ['webhook.mjs'], { cwd: dir, stdio: 'inherit' });
