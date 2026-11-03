// The three starters in examples/, run as written (since v0.9.0): every file of each, on a real Postgres database
// of its own through its own lib/db.ts (postgres-js), with signed webhooks into its routes. Only Paddle is faked
// (the readiness key check's GET /), so nothing leaves the machine.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFixture } from './helpers/fixtures';
import { realPostgres } from './helpers/real-pg';
import { sign } from './helpers/sign';

const live = await realPostgres('starters suite (examples/)');
afterAll(async () => { await live?.stop(); });

const SECRET = 'pdl_ntfset_starter_secret';
const HEALTH = 'health_token_starter';
const CRON = 'cron_secret_starter';
const PERMISSIONS = ['notification.read', 'subscription.read', 'transaction.read', 'adjustment.read', 'price.read', 'product.read'];

beforeEach(() => {
  vi.stubGlobal('fetch', async (url: string) => {
    if (url !== 'https://sandbox-api.paddle.com/') throw new Error(`unexpected Paddle call ${url}`);
    return Response.json({ data: { api: { environment: 'sandbox' }, caller: { permissions: PERMISSIONS } } });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function boot(name: 'subscription' | 'unlock' | 'credits', prices: Record<string, string>) {
  const { default: postgres } = await import('postgres');
  const database = `st_${name}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = postgres(live!.url, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${database}`);
  await admin.end();
  const env: Record<string, string> = {
    DATABASE_URL: live!.url.replace(/\/postgres$/, `/${database}`), PADDLE_ENV: 'sandbox', PADDLE_NOTIFICATION_WEBHOOK_SECRET: SECRET,
    PADDLE_API_KEY: 'pdl_sdbx_apikey_starter0000000000000000', PADDLE_PRICES: JSON.stringify(prices), PADDLE_HEALTH_TOKEN: HEALTH, CRON_SECRET: CRON, NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: 'test_clienttoken000000000000',
  };
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.resetModules();
  const load = (path: string) => import(`../examples/${name}/${path}`);
  await (await load('lib/migrate')).migrate();
  const webhook = await load('app/api/paddle/route');
  const send = async (event: unknown) => {
    const body = JSON.stringify(event);
    return webhook.POST(new Request('https://app.test/api/paddle', { method: 'POST', headers: { 'paddle-signature': sign(body, SECRET) }, body })) as Promise<Response>;
  };
  const health = async () => (await (await webhook.GET(new Request('https://app.test/api/paddle', { headers: { authorization: `Bearer ${HEALTH}` } }))).json()) as any;
  const cron = (route: string, auth = `Bearer ${CRON}`) => load(route).then((m) => m.GET(new Request('https://app.test/cron', { headers: { authorization: auth } })) as Promise<Response>);
  return { load, send, health, cron, problems: (await load('lib/billing')).problems as string[] };
}

const n = () => Math.random().toString(36).slice(2, 8);
function payment(o: { priceId: string; userId: string | null; quantity?: number }) {
  const base = loadFixture('transaction.completed');
  const id = `txn_${n()}`;
  return { ...base, event_id: `evt_${n()}`, occurred_at: new Date().toISOString(), data: { ...base.data, id, subscription_id: null,
    custom_data: o.userId ? { userId: o.userId } : null, items: [{ ...base.data.items[0], price: { ...base.data.items[0].price, id: o.priceId }, quantity: o.quantity ?? 1 }] } };
}
function refund(transactionId: string, status = 'approved') {
  const base = loadFixture('adjustment.created');
  return { ...base, event_id: `evt_${n()}`, event_type: 'adjustment.updated', occurred_at: new Date().toISOString(),
    data: { ...base.data, id: `adj_${transactionId}`, transaction_id: transactionId, action: 'refund', type: 'full', status, subscription_id: null, updated_at: new Date().toISOString() } };
}

describe.skipIf(!live)('starters, run as written', () => {
  it('subscription: a plan unlocks its feature; health is green; the cron routes refuse without the secret', async () => {
    const app = await boot('subscription', { pro: 'pri_pro' });
    expect(app.problems.join("; ")).toBe("");
    const base = loadFixture('subscription.created');
    const event = { ...base, event_id: `evt_${n()}`, occurred_at: new Date().toISOString(),
      data: { ...base.data, status: 'active', custom_data: { userId: 'u_sub' }, items: base.data.items.map((i: any) => ({ ...i, price: { ...i.price, id: 'pri_pro' } })) } };
    expect((await app.send(event)).status).toBe(200);
    const { canUse } = await app.load('lib/policy');
    expect(await canUse('u_sub', 'pro')).toBe(true);
    expect(await canUse('u_other', 'pro')).toBe(false);
    const h = await app.health();
    expect(h.checks.paddle_api_key.ok).toBe(true);
    expect(h.checks.migrations.ok).toBe(true);
    expect((await app.cron('app/api/cron/billing-recovery/route', 'Bearer wrong')).status).toBe(401);
  });

  it('unlock: payment unlocks once, the receipt goes out through the outbox route, a refund locks it, a second payment is a review', async () => {
    const app = await boot('unlock', { lifetime: 'pri_life' });
    expect(app.problems.join("; ")).toBe("");
    const { canUse } = await app.load('lib/policy');
    const paid = payment({ priceId: 'pri_life', userId: 'u1' });
    expect((await app.send(paid)).status).toBe(200);
    expect((await app.send({ ...paid, event_id: `evt_${n()}` })).status).toBe(200); // a replay: nothing more
    expect(await canUse('u1')).toBe(true);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect((await app.cron('app/api/cron/outbox/route', 'Bearer wrong')).status).toBe(401);
    expect(await (await app.cron('app/api/cron/outbox/route')).json()).toEqual({ sent: 1, failed: 0, gaveUp: 0, lost: 0 });
    expect(info).toHaveBeenCalledWith('paddle-kit receipt', `${paid.data.id}:receipt`, 'u1');
    expect((await app.health()).checks).toMatchObject({ outbox: { ok: true }, reviews: { ok: true }, migrations: { ok: true } });

    const again = payment({ priceId: 'pri_life', userId: 'u1' }); // paid twice: declined, a person refunds it
    expect((await app.send(again)).status).toBe(200);
    expect((await app.health()).checks.reviews).toEqual({ ok: false, detail: '1 unresolved fulfilment review (declined:already_unlocked)' });

    expect((await app.send(refund(paid.data.id))).status).toBe(200);
    expect(await canUse('u1')).toBe(false);
  });

  it('credits: a 2-pack grants 200, spending is atomic, a refund takes back only what is left; an unmatched payment is a review', async () => {
    const app = await boot('credits', { pack: 'pri_pack' });
    expect(app.problems.join("; ")).toBe("");
    const { creditsOf, spendCredits } = await app.load('lib/credits');
    const paid = payment({ priceId: 'pri_pack', userId: 'u2', quantity: 2 });
    expect((await app.send(paid)).status).toBe(200);
    expect(await creditsOf('u2')).toBe(200);
    expect(await Promise.all([spendCredits('u2', 150), spendCredits('u2', 150)])).toEqual(expect.arrayContaining([true, false]));
    expect((await app.send(refund(paid.data.id))).status).toBe(200);
    expect(await creditsOf('u2')).toBe(0); // 50 were left: those are taken, the 150 spent stay spent
    vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(await (await app.cron('app/api/cron/outbox/route')).json()).toMatchObject({ sent: 1 });
    expect((await app.send(payment({ priceId: 'pri_pack', userId: null }))).status).toBe(200);
    expect((await app.health()).checks.reviews).toEqual({ ok: false, detail: '1 unresolved fulfilment review (unfulfilled_payment)' });
  });
});
