import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Runs a TypeScript block of README.md as written: the first ```ts block after `marker`, transpiled, with its imports
// mapped to the given modules (anything else throws, so an example can't silently import something untested).
const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

export function readmeBlockAfter(marker: string): string {
  const at = readme.indexOf(marker);
  if (at < 0) throw new Error(`README has no ${marker}`);
  return /```ts\n([\s\S]*?)```/.exec(readme.slice(at))![1]!;
}

export function runReadmeBlock(marker: string, modules: Record<string, unknown>, globals: Record<string, unknown> = {}): Record<string, any> {
  const js = ts.transpileModule(readmeBlockAfter(marker), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, any> = {};
  const require = (m: string) => {
    if (m in modules) return modules[m];
    throw new Error(`README block after ${marker} imports ${m}`);
  };
  new Function('exports', 'require', ...Object.keys(globals), js)(exports, require, ...Object.values(globals));
  return exports;
}
