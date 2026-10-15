import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tgz = execFileSync('npm', ['pack', '--silent'], { encoding: 'utf8' }).trim().split('\n').at(-1);
const dir = mkdtempSync(join(tmpdir(), 'paddle-kit-smoke-'));
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'smoke', type: 'module', private: true }));
execFileSync('npm', ['i', '--silent', resolve(tgz), '@paddle/paddle-node-sdk@3.10.0', '@paddle/paddle-js', 'hono', 'express'], { cwd: dir, stdio: 'inherit' });
const subpaths = ['core', 'memory', 'postgres', 'next', 'hono', 'express', 'client', 'reconcile'];
const code = subpaths.map((p) => `await import('paddle-kit/${p}');`).join('\n') + "\nconsole.log('all subpaths import');";
writeFileSync(join(dir, 'check.mjs'), code);
execFileSync('node', ['check.mjs'], { cwd: dir, stdio: 'inherit' });
