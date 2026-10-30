import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as core from '../src/core';
import * as client from '../src/client';
import * as reconcile from '../src/reconcile';
import * as next from '../src/next';
import * as price from '../src/price';
import * as config from '../src/config';

// The public surface. Growing it is a decision: change this list on purpose (0.6.0 added ./price and the doctor bin;
// 0.7.0 added findPrice and findPriceMap to ./price, adjustmentEffect to ./core, reconcilePayments to ./reconcile,
// billingFromEnv to ./config).
it('package.json exports exactly the v0.7 subpaths (unchanged since v0.6) and bins', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(Object.keys(pkg.exports)).toEqual(['./core', './memory', './postgres', './sqlite', './next', './client', './reconcile', './plan', './config', './catalog', './price']);
  expect(pkg.bin).toEqual({ 'paddle-kit-catalog': './dist/catalog/cli.js', 'paddle-kit-doctor': './dist/doctor/cli.js' });
  for (const e of Object.values(pkg.exports) as Record<string, string>[]) expect(Object.keys(e)).toEqual(['types', 'default']);
  expect(Object.keys(pkg.peerDependencies ?? {})).toEqual(['@paddle/paddle-js']);
  expect(pkg.files).toEqual(['dist']);
});

it('runtime exports of core, client, reconcile, next, price and config', () => {
  expect(Object.keys(config).sort()).toEqual(['billingFromEnv', 'readBillingEnv']);
  expect(Object.keys(next).sort()).toEqual(['createNextRoute', 'createWebhookRoute']);
  expect(Object.keys(price).sort()).toEqual(['PriceError', 'findPrice', 'findPriceMap', 'formatPrice', 'getPrice']);
  expect(Object.keys(core).sort()).toEqual(['MAX_WEBHOOK_BODY_BYTES', 'adjustmentEffect', 'createBilling']);
  expect(Object.keys(client).sort()).toEqual(['createCheckout']);
  expect(Object.keys(reconcile).sort()).toEqual(['reconcile', 'reconcilePayments']);
});
