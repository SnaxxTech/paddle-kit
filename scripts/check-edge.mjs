import { readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, normalize } from 'node:path';

// Entry directories that must run on edge runtimes. catalog/ and sqlite/ are Node-only and deliberately absent.
const EDGE_SAFE = ['core', 'memory', 'postgres', 'next', 'hono', 'plan', 'config'];
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
const visit = (f) => {
  if (reachable.has(f)) return;
  reachable.add(f);
  const src = readFileSync(join('dist', f), 'utf8');
  for (const m of src.matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.{1,2}\/[^"']+\.js)["']/g)) {
    visit(normalize(join(dirname(f), m[1])));
  }
};
entries.forEach(visit);
const files = [...reachable];

let bad = 0;
for (const f of files) {
  const src = readFileSync(join('dist', f), 'utf8');
  for (const pattern of [nodeImport, /require\(/, /\bBuffer\b/, /\bprocess\.(?!env)/]) {
    if (pattern.test(src)) {
      console.error(`EDGE VIOLATION ${f}: ${pattern.source.slice(0, 60)}`);
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
