import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'core/index': 'src/core/index.ts',
    'memory/index': 'src/memory/index.ts',
    'postgres/index': 'src/postgres/index.ts',
    'next/index': 'src/next/index.ts',
    'hono/index': 'src/hono/index.ts',
    'express/index': 'src/express/index.ts',
    'client/index': 'src/client/index.ts',
    'reconcile/index': 'src/reconcile/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: true,
  external: ['@paddle/paddle-node-sdk', '@paddle/paddle-js', 'hono', 'express'],
});
