// Audit reproductions using fake data only. Run with: node --import tsx docs/audits/paddle-kit-probes.ts
import { createBilling } from '../../src/core/billing.ts';
import { memoryStore } from '../../src/memory/index.ts';
import { diagnose } from '../../src/doctor/cli.ts';
import { readBillingEnv } from '../../src/config/index.ts';
import { paddleClient } from '../../src/core/paddle-api.ts';
import { sign } from '../../tests/helpers/sign.ts';
import type { Subscription } from '../../src/core/types.ts';

const now = new Date('2026-10-30T12:00:00Z');
const secret = 'audit_fake_secret';
const emit = (name: string, evidence: unknown) => console.log(JSON.stringify({ name, evidence }));
const cfg = { environment: 'sandbox' as const, webhookSecret: secret, entitlements: { pri_audit: ['pro'] }, now: () => now, log: () => {} };

// A signed parse error arrives after a still-unresolved hook failure.
const healthStore = memoryStore();
await healthStore.recordEvent({ eventId:'evt_hook', eventType:'transaction.completed', occurredAt:now.toISOString(),receivedAt:now.toISOString() });
await healthStore.markEvent('evt_hook','failed','hook_error');
await healthStore.recordFailure('bad_json',new Date(now.getTime()+1000));
const health = await healthStore.health(new Date(now.getTime()+2000));
emit('unresolved_failure_masked', { health, doctor: diagnose(200,JSON.stringify(health), {now:now.getTime()+2000}) });

const stuck = memoryStore();
await stuck.recordEvent({eventId:'evt_crash', eventType:'transaction.completed', occurredAt:'2026-10-29T12:00:00Z',receivedAt:'2026-10-29T12:00:00Z',leaseExpiredBefore:'2026-10-29T11:59:00Z'});
const stuckHealth = await stuck.health(now);
emit('crashed_claim_invisible', { health:stuckHealth,doctor:diagnose(200,JSON.stringify(stuckHealth),{now:now.getTime()}) });
emit('wrong_owns_green', diagnose(200,JSON.stringify({lastEventAt:now.toISOString(),lastOwnedAt:null,notOursLast24h:100,failedLast24h:0,lastFailureReason:null,lastFailureAt:null,unlinkedLast24h:0}), {now:now.getTime(),staleHours:1}));

const valid = {PADDLE_ENV:'sandbox',PADDLE_NOTIFICATION_WEBHOOK_SECRET:secret,NEXT_PUBLIC_PADDLE_CLIENT_TOKEN:'test_audit',PADDLE_PRICES:JSON.stringify({team25:'pri_audit'})};
emit('flat_price_accepts_required_cycles', readBillingEnv(valid,{requiredPrices:['team25'],requiredCycles:['monthly','yearly']}));

let pages=0;
const api=paddleClient('https://sandbox-api.paddle.com','pdl_sdbx_fake',async()=>({ok:true,status:200,json:async()=>({data:[{id:++pages}],meta:{pagination:{has_more:true,next:'https://sandbox-api.paddle.com/transactions?after=x'}}})}),[]);
emit('pagination_silently_truncated',{rows:await api.list('/transactions',2),pages});

const store=memoryStore();
const earlier='2026-10-23T11:00:00Z', later='2026-10-23T13:00:00Z';
const active:Subscription={subscriptionId:'sub_audit',customerId:'ctm_audit',userId:'org_audit',status:'active',priceIds:['pri_audit'],currentPeriodEnd:null,scheduledChange:null,canceledAt:null,pastDueSince:null,lastEventAt:'2026-10-22T12:00:00Z',raw:{}};
await store.upsertSubscription(active);
let reads=0;
let releaseReads!:()=>void, releaseNewer!:()=>void;
const bothRead=new Promise<void>(r=>releaseReads=r), newerApplied=new Promise<void>(r=>releaseNewer=r);
const concurrent={...store,
 async getSubscription(id:string){const s=await store.getSubscription(id); if(++reads===2)releaseReads();await bothRead;return s;},
 async upsertSubscription(s:Subscription){if(s.lastEventAt===earlier)await newerApplied;const r=await store.upsertSubscription(s);if(s.lastEventAt===later)releaseNewer();return r;}
};
const b=createBilling({...cfg,store:concurrent});
async function send(id:string,at:string){const body=JSON.stringify({event_id:id,event_type:'subscription.past_due',occurred_at:at,data:{id:'sub_audit',customer_id:'ctm_audit',status:'past_due',items:[{price:{id:'pri_audit'},quantity:1}],custom_data:{userId:'org_audit'}}});return b.handleWebhook(new Request('https://audit.test',{method:'POST',headers:{'paddle-signature':sign(body,secret,Math.floor(now.getTime()/1000))},body}));}
const responses=await Promise.all([send('evt_earlier',earlier),send('evt_later',later)]);
emit('concurrent_grace_extended',{http:responses.map(r=>r.status),expectedPastDueSince:earlier,actualPastDueSince:(await store.getSubscription('sub_audit'))?.pastDueSince,expectedAccess:false,actualAccess:await b.hasAccess('org_audit','pro')});

// An old delinquency must not shorten the grace period of a later delinquency after recovery.
const episodeStore = memoryStore();
let episodeNow = new Date('2026-10-25T12:00:00Z');
const episodeBilling = createBilling({...cfg, store:episodeStore, now:()=>episodeNow});
async function episodeEvent(id:string, status:string, occurredAt:string) {
  const body=JSON.stringify({event_id:id,event_type:'subscription.updated',occurred_at:occurredAt,data:{id:'sub_episode',customer_id:'ctm_audit',status,items:[{price:{id:'pri_audit'},quantity:1}],custom_data:{userId:'org_episode'}}});
  return episodeBilling.handleWebhook(new Request('https://audit.test',{method:'POST',headers:{'paddle-signature':sign(body,secret,Math.floor(episodeNow.getTime()/1000))},body}));
}
await episodeEvent('evt_recovered','active','2026-10-23T12:00:00Z');
await episodeEvent('evt_new_delinquency','past_due','2026-10-24T12:00:00Z');
const accessBeforeOldEvent=await episodeBilling.hasAccess('org_episode','pro');
await episodeEvent('evt_old_delinquency','past_due','2026-10-23T11:00:00Z');
episodeNow = new Date('2026-10-30T12:00:00Z');
emit('old_delinquency_revokes_new_grace',{accessBeforeOldEvent,expectedAccessAfterOldEvent:true,actualAccessAfterOldEvent:await episodeBilling.hasAccess('org_episode','pro'),pastDueSince:(await episodeStore.getSubscription('sub_episode'))?.pastDueSince});
