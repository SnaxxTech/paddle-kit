import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tgz = execFileSync('npm', ['pack', '--silent'], { encoding: 'utf8' }).trim().split('\n').at(-1);
const dir = mkdtempSync(join(tmpdir(), 'paddle-kit-smoke-'));
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'smoke', type: 'module', private: true }));
execFileSync('npm', ['i', '--silent', resolve(tgz), '@paddle/paddle-node-sdk@3.10.0', '@paddle/paddle-js', 'hono', 'express', 'typescript@5.9.3', '@types/express', '@types/node'], { cwd: dir, stdio: 'inherit' });
const subpaths = ['core', 'memory', 'postgres', 'sqlite', 'next', 'hono', 'express', 'client', 'reconcile', 'plan', 'config', 'catalog'];
const code = subpaths.map((p) => `await import('paddle-kit/${p}');`).join('\n') + "\nconsole.log('all subpaths import');";
// CommonJS-style resolvers (Playwright, tsx, Jest) resolve through the "default" condition.
const resolveCheck = subpaths.map((p) => `require.resolve('paddle-kit/${p}');`).join('\n') + "\nconsole.log('all subpaths resolve via require');";
writeFileSync(join(dir, 'check.mjs'), code);
execFileSync('node', ['check.mjs'], { cwd: dir, stdio: 'inherit' });
writeFileSync(join(dir, 'resolve.cjs'), resolveCheck);
execFileSync('node', ['resolve.cjs'], { cwd: dir, stdio: 'inherit' });

// Prove the published types resolve for NodeNext consumers.
writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: false, types: [] }, files: ['check.mts'] }));
writeFileSync(join(dir, 'check.mts'), `import type { Billing } from 'paddle-kit/core';
import { memoryStore } from 'paddle-kit/memory';
import { postgresStore } from 'paddle-kit/postgres';
import { sqliteStore } from 'paddle-kit/sqlite';
import { createNextRoute } from 'paddle-kit/next';
import { paddleWebhook } from 'paddle-kit/hono';
import { paddleWebhook as ex } from 'paddle-kit/express';
import { createCheckout } from 'paddle-kit/client';
import { reconcile } from 'paddle-kit/reconcile';
import { planOf, type Plan } from 'paddle-kit/plan';
import { readBillingEnv, type BillingEnv, type PriceMap } from 'paddle-kit/config';
import { syncCatalog, validateCatalog, type Catalog } from 'paddle-kit/catalog';
export type T = [Billing, typeof memoryStore, typeof postgresStore, typeof sqliteStore, typeof createNextRoute, typeof paddleWebhook, typeof ex, typeof createCheckout, typeof reconcile, typeof planOf, Plan, typeof readBillingEnv, BillingEnv, PriceMap, typeof syncCatalog, typeof validateCatalog, Catalog];
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
