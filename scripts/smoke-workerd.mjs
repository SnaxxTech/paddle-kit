// The built kit inside real workerd (Cloudflare Workers' runtime, through Miniflare), since v0.9.0. check:edge reads
// the source for Node-only imports; this runs the code: a Workers-only failure (a fetch option workerd rejects, as
// `redirect: "error"` did in v0.8.6, which threw before any request) fails here. Every outgoing fetch is answered by
// `outboundService`, offline. (It sees every request as redirect "follow", so a mode is not asserted, only the result.)
// Needs `npm run build`. Run: npm run smoke:workerd
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const worker = `
import { createBilling, createPaddleTransport } from './dist/core/index.js';
import { memoryStore } from './dist/memory/index.js';
import { readinessChecks } from './dist/config/index.js';
import { createWebhookRoute } from './dist/next/index.js';
import { createRecoveryRoute } from './dist/reconcile/index.js';
import { getPrice } from './dist/price/index.js';
import { createOutboxRoute } from './dist/fulfil/index.js';
import { fromPostgresJs } from './dist/db/index.js';
import './dist/server/index.js';
import './dist/plan/index.js';

const KEY = 'pdl_sdbx_apikey_smoke0000000000000000000';
async function sign(body, secret) {
  const ts = Math.floor(Date.now() / 1000);
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(ts + ':' + body)));
  return 'ts=' + ts + ';h1=' + [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const step = async (f) => { try { return await f(); } catch (e) { return 'THROW ' + (e && e.name) + ': ' + String(e && e.message).slice(0, 120); } };

export default { async fetch() {
  const out = {};
  out.transport = await step(async () => (await createPaddleTransport().fetch('https://sandbox-api.paddle.com/event-types', { method: 'GET', headers: { Authorization: 'Bearer ' + KEY } })).status);
  out.readiness = await step(async () => (await readinessChecks({ apiKey: KEY, environment: 'sandbox', permissions: [] }).paddle_api_key()).ok);
  out.price = await step(async () => (await getPrice('pri_01smoke', { apiKey: KEY, environment: 'sandbox' })).id);
  const billing = createBilling({ environment: 'sandbox', webhookSecret: 'pdl_ntfset_smoke', store: memoryStore(), entitlements: { pri_pro: ['pro'] }, healthToken: 'health_smoke', log: () => {} });
  const route = createWebhookRoute({ billing, problems: [] });
  const event = { event_id: 'evt_smoke', event_type: 'subscription.created', occurred_at: new Date().toISOString(), data: {
    id: 'sub_smoke', status: 'active', customer_id: 'ctm_1', custom_data: { userId: 'u1' }, updated_at: new Date().toISOString(),
    items: [{ price: { id: 'pri_pro' }, quantity: 1 }], current_billing_period: { ends_at: '2099-01-01T00:00:00Z' }, scheduled_change: null } };
  const body = JSON.stringify(event);
  out.webhook = await step(async () => (await route.POST(new Request('https://app.test/api/paddle', { method: 'POST', headers: { 'paddle-signature': await sign(body, 'pdl_ntfset_smoke') }, body }))).status);
  out.forged = await step(async () => (await route.POST(new Request('https://app.test/api/paddle', { method: 'POST', headers: { 'paddle-signature': await sign(body, 'pdl_ntfset_wrong') }, body }))).status);
  out.access = await step(() => billing.hasAccess('u1', 'pro'));
  out.health = await step(async () => (await route.GET(new Request('https://app.test/api/paddle', { headers: { authorization: 'Bearer health_smoke' } }))).status);
  out.recovery401 = await step(async () => (await createRecoveryRoute({ billing, problems: [], apiKey: KEY, cronSecret: 'c' }).GET(new Request('https://app.test/'))).status);
  out.outbox401 = await step(async () => (await createOutboxRoute({ cronSecret: 'c', drain: async () => ({ sent: 0, failed: 0, gaveUp: 0, lost: 0 }) }).GET(new Request('https://app.test/'))).status);
  out.db = typeof fromPostgresJs;
  return Response.json(out);
} };`;

const bundled = await build({ stdin: { contents: worker, resolveDir: process.cwd(), loader: 'js' }, bundle: true, format: 'esm', platform: 'neutral',
  mainFields: ['module', 'main'], write: false, logLevel: 'error' });
const mf = new Miniflare({
  modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2024-09-23',
  outboundService: async (req) => {
    const path = new URL(req.url).pathname;
    if (path === '/') return Response.json({ data: { api: { environment: 'sandbox' }, caller: { permissions: ['notification.read', 'subscription.read', 'transaction.read', 'adjustment.read'] } } });
    if (path.startsWith('/prices/')) return Response.json({ data: { id: 'pri_01smoke', product_id: 'pro_1', status: 'active', unit_price: { amount: '1000', currency_code: 'USD' }, billing_cycle: null, description: 'x', name: 'x', custom_data: null } });
    return Response.json({ data: [], meta: { pagination: { has_more: false, next: null } } });
  },
});
let report;
try { report = await (await mf.dispatchFetch('http://localhost/')).json(); } finally { await mf.dispose(); }
const expected = { transport: 200, readiness: true, price: 'pri_01smoke', webhook: 200, forged: 401, access: true, health: 200, recovery401: 401, outbox401: 401, db: 'function' };
const wrong = Object.entries(expected).filter(([k, v]) => report[k] !== v).map(([k, v]) => `${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(report[k])}`);
if (wrong.length > 0) { console.error(`workerd smoke FAILED:\n  ${wrong.join('\n  ')}`); process.exit(1); }
console.log(`workerd smoke: ${Object.keys(expected).length} checks pass in real workerd`);
