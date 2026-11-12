import ts from 'typescript';
import * as core from '../../src/core';
import type { BillingConfig } from '../../src/core';
import { readme } from './readme-blocks'; // README.md plus the docs the reference moved to

// The README's "One-time purchases and refunds" example, read out of README.md: its SQL block (the tables) and its
// TypeScript block, transpiled and run with `paddle-kit/core` mapped to src, so tests run the example exactly as written.
export type Tx = { query(text: string, params?: unknown[]): Promise<{ rows: any[] }> };
const example = readme.slice(readme.indexOf('### Example\n'), readme.indexOf('### Refunds, chargebacks and reversals'));
const block = (lang: string) => new RegExp('```' + lang + '\\n([\\s\\S]*?)```').exec(example)![1]!;

export const readmeSql = block('sql');

export function readmePackHooks(db: { transaction<T>(fn: (q: Tx) => Promise<T>): Promise<T> }) {
  const js = ts.transpileModule(block('ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: { packHooks?: (priceId: string, creditsPerUnit?: number) => Pick<BillingConfig, 'onTransaction' | 'onAdjustment'> } = {};
  const require = (m: string) => {
    if (m === 'paddle-kit/core') return core;
    throw new Error(`README example imports ${m}`);
  };
  new Function('exports', 'require', 'db', js)(exports, require, db);
  return exports.packHooks!;
}
