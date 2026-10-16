import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as core from '../src/core';
import * as client from '../src/client';
import * as reconcile from '../src/reconcile';

// The v0.4.0 public surface. Growing it is a decision: change this list on purpose.
it('package.json exports exactly the v0.4 subpaths', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(Object.keys(pkg.exports)).toEqual(['./core', './memory', './postgres', './sqlite', './next', './client', './reconcile', './plan', './config', './catalog']);
  for (const e of Object.values(pkg.exports) as Record<string, string>[]) expect(Object.keys(e)).toEqual(['types', 'default']);
  expect(Object.keys(pkg.peerDependencies ?? {})).toEqual(['@paddle/paddle-js']);
  expect(pkg.files).toEqual(['dist']);
});

it('runtime exports of core, client and reconcile', () => {
  expect(Object.keys(core).sort()).toEqual(['createBilling']);
  expect(Object.keys(client).sort()).toEqual(['createCheckout']);
  expect(Object.keys(reconcile).sort()).toEqual(['reconcile']);
});
