import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tgz = execFileSync('npm', ['pack', '--silent'], { encoding: 'utf8' }).trim().split('\n').at(-1);
const dir = mkdtempSync(join(tmpdir(), 'paddle-kit-smoke-'));
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'smoke', type: 'module', private: true }));
execFileSync('npm', ['i', '--silent', resolve(tgz), '@paddle/paddle-node-sdk@3.10.0', '@paddle/paddle-js', 'hono', 'express', 'typescript@5.9.3', '@types/express', '@types/node'], { cwd: dir, stdio: 'inherit' });
const subpaths = ['core', 'memory', 'postgres', 'sqlite', 'next', 'hono', 'express', 'client', 'reconcile'];
const code = subpaths.map((p) => `await import('paddle-kit/${p}');`).join('\n') + "\nconsole.log('all subpaths import');";
writeFileSync(join(dir, 'check.mjs'), code);
execFileSync('node', ['check.mjs'], { cwd: dir, stdio: 'inherit' });

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
export type T = [Billing, typeof memoryStore, typeof postgresStore, typeof sqliteStore, typeof createNextRoute, typeof paddleWebhook, typeof ex, typeof createCheckout, typeof reconcile];
`);
execFileSync('npx', ['tsc', '-p', '.'], { cwd: dir, stdio: 'inherit' });
console.log('types resolve under NodeNext');
