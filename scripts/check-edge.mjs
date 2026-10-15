import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const EDGE_SAFE = ['core', 'memory', 'postgres', 'next', 'hono'];
const files = readdirSync('dist', { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.js'))
  .filter((f) => EDGE_SAFE.some((d) => f.startsWith(`${d}/`)) || /^chunk-.*\.js$/.test(f));
let bad = 0;
for (const f of files) {
  const src = readFileSync(join('dist', f), 'utf8');
  for (const pattern of [/from\s+["']node:/, /require\(/, /\bBuffer\b/, /\bprocess\.(?!env)/]) {
    if (pattern.test(src)) {
      console.error(`EDGE VIOLATION ${f}: ${pattern}`);
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
