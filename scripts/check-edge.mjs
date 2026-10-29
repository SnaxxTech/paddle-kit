import { readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, normalize } from 'node:path';

// Entry directories that must run on edge runtimes. catalog/, doctor/ and sqlite/ are Node-only and deliberately absent.
const EDGE_SAFE = ['core', 'memory', 'postgres', 'next', 'reconcile', 'plan', 'config', 'price'];
const all = readdirSync('dist', { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.js'));
const entries = all.filter((f) => EDGE_SAFE.some((d) => f.startsWith(`${d}/`)));

// tsup strips the `node:` prefix (esbuild emits `from "fs"`), so a bare builtin specifier must be caught too.
const BUILTIN = builtinModules.filter((m) => !m.startsWith('_')).map((m) => m.replace(/[/]/g, '\\/'));
const nodeImport = new RegExp(`(?:from\\s*|import\\s*\\(?\\s*)["'](?:node:[^"']+|(?:${BUILTIN.join('|')}))["']`);

// Shared chunks only count when an edge entry (transitively) imports them, so a Node-only
// entry's private chunk is not mistaken for edge code and an edge file can never hide in one.
const reachable = new Set();
const reachedFrom = new Map(); // chunk -> the file that first imported it
const visit = (f, from) => {
  if (reachable.has(f)) return;
  reachable.add(f);
  if (from) reachedFrom.set(f, from);
  const src = readFileSync(join('dist', f), 'utf8');
  for (const m of src.matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.{1,2}\/[^"']+\.js)["']/g)) {
    visit(normalize(join(dirname(f), m[1])), f);
  }
};
entries.forEach((f) => visit(f));
const files = [...reachable];

let bad = 0;
for (const f of files) {
  const src = readFileSync(join('dist', f), 'utf8');
  for (const pattern of [nodeImport, /require\(/, /\bBuffer\b/, /\bprocess\.(?!env)/]) {
    const hit = pattern.exec(src);
    if (hit) {
      // Name the file, the offending text, and (for a shared chunk) the file that pulls it into the edge graph.
      const chain = [];
      for (let x = reachedFrom.get(f); x; x = reachedFrom.get(x)) chain.push(x);
      console.error(`EDGE VIOLATION ${f}: ${hit[0].trim()}${chain.length ? ` (reached from ${chain.join(' <- ')})` : ''}`);
      bad++;
    }
  }
}
if (files.length === 0) {
  console.error('no dist files found — run npm run build first');
  process.exit(1);
}
console.log(`checked ${files.length} files, ${bad} violations`);
process.exit(bad ? 1 : 0);
