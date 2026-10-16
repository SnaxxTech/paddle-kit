import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const script = path.resolve(__dirname, '../scripts/check-edge.mjs');

function run(files: Record<string, string>) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'check-edge-'));
  for (const [f, src] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(cwd, 'dist', f)), { recursive: true });
    writeFileSync(path.join(cwd, 'dist', f), src);
  }
  try {
    return { code: 0, out: execFileSync('node', [script], { cwd, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e: any) {
    return { code: e.status as number, out: String(e.stderr) + String(e.stdout) };
  }
}

describe('check-edge', () => {
  test('clean edge entry plus a Node-only catalog chunk passes', () => {
    const r = run({
      'core/index.js': 'export const a = 1;',
      'catalog/index.js': 'import { x } from "../chunk-AAA.js"; export { x };',
      'chunk-AAA.js': 'import fs from "fs"; export const x = fs;',
    });
    expect(r.code).toBe(0);
  });

  test('a violation names the file, the import specifier and the entry that reaches the chunk', () => {
    const r = run({
      'core/index.js': 'import { x } from "../chunk-BBB.js"; export { x };',
      'chunk-BBB.js': 'import p from "node:path"; export const x = p;',
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('chunk-BBB.js');
    expect(r.out).toContain('node:path');
    expect(r.out).toContain('core/index.js');
  });

  test('a bare builtin in an entry is named too', () => {
    const r = run({ 'plan/index.js': 'import fs from "fs"; export default fs;' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/plan\/index\.js.*"fs"|"fs".*plan\/index\.js/s);
  });
});
