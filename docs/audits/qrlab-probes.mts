// Audit reproduction: copy into the reviewed app at the path documented in 2026-10-30-paddle-kit-review.md.
import { createBilling } from 'paddle-kit/core';
import { memoryStore } from 'paddle-kit/memory';
import { runReconcile, billingFrom, paidTier } from './src/lib/billing.ts';
import { createHmac } from 'node:crypto';
const billing=createBilling({environment:'sandbox',webhookSecret:'audit-secret',store:memoryStore(),entitlements:{},owns:{priceIds:['pri_audit']},log:()=>{},onTransaction:()=>{throw new Error('injected fulfilment failure')}});
const fake=async (url:string)=>Response.json({data:new URL(url).pathname==='/transactions'?[{id:'txn_audit',status:'completed',updated_at:new Date().toISOString(),items:[{price:{id:'pri_audit'},quantity:1}]}]:[],meta:{pagination:{has_more:false}}});
console.log(JSON.stringify({name:'reconcile_failure_returns_done',evidence:await runReconcile(billing,'pdl_sdbx_fake',fake)}));
const prices={starter:{monthly:'pri_sm',yearly:'pri_sy'},pro:{monthly:'pri_pm',yearly:'pri_py'},agency:{monthly:'pri_am',yearly:'pri_ay'}};
const env={PADDLE_ENV:'sandbox',PADDLE_NOTIFICATION_WEBHOOK_SECRET:'audit_old,audit_new',PADDLE_PRICES:JSON.stringify(prices),NEXT_PUBLIC_PADDLE_CLIENT_TOKEN:'test_audit'};
const state=billingFrom(env,async()=>({rows:[]}));
const body=JSON.stringify({event_id:'evt_rotation',event_type:'unhandled.audit',occurred_at:new Date().toISOString(),data:{}});
const ts=Math.floor(Date.now()/1000);
const h1=createHmac('sha256','audit_new').update(`${ts}:${body}`).digest('hex');
const res=await state.billing!.handleWebhook(new Request('https://audit.test',{method:'POST',headers:{'paddle-signature':`ts=${ts};h1=${h1}`},body}));
console.log(JSON.stringify({name:'rotation_new_secret_rejected',problems:state.problems,http:res.status,body:await res.json()}));

const broken=billingFrom({...env,PADDLE_NOTIFICATION_WEBHOOK_SECRET:'',BILLING_ENFORCE:'1'},async()=>({rows:[]}));
console.log(JSON.stringify({name:'misconfigured_billing_enforced_still_pro',problems:broken.problems,tier:await paidTier(broken.billing,'workspace_audit')}));
