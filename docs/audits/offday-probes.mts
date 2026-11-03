// Audit reproduction: copy into the reviewed app at the path documented in 2026-10-30-paddle-kit-review.md.
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const auditDir = mkdtempSync(join(tmpdir(), 'offday-billing-audit-'));
process.env.DATABASE_PATH=join(auditDir, 'offday.db');
process.env.PADDLE_ENV='sandbox';
process.env.PADDLE_NOTIFICATION_WEBHOOK_SECRET='audit_secret';
process.env.PADDLE_PRICES=JSON.stringify({team25:{monthly:'pri_t25m',yearly:'pri_t25y'},team50:{monthly:'pri_t50m',yearly:'pri_t50y'},extra:{monthly:'pri_extra_m',yearly:'pri_extra_y'}});
process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN='test_audit';
process.env.BILLING_LAUNCH_AT='2025-01-01T00:00:00Z';
process.env.BILLING_ENFORCE='1';
const {billing,planFor,enforcePlan}=await import('./lib/billing.ts');
const {database}=await import('./lib/store.ts');
database.prepare('INSERT OR IGNORE INTO organizations (id,name,created_at,demo) VALUES (?,?,?,0)').run('org_audit','Audit',0);
const body=JSON.stringify({event_id:'evt_addon_only',event_type:'subscription.created',occurred_at:new Date().toISOString(),data:{id:'sub_audit',customer_id:'ctm_audit',status:'active',items:[{price:{id:'pri_extra_m'},quantity:1}],custom_data:{userId:'org_audit'}}});
const ts=Math.floor(Date.now()/1000);
const h1=createHmac('sha256','audit_secret').update(`${ts}:${body}`).digest('hex');
const res=await billing()!.handleWebhook(new Request('https://audit.test',{method:'POST',headers:{'paddle-signature':`ts=${ts};h1=${h1}`},body}));
let blocked=false;
try{await enforcePlan('org_audit','addHoliday')}catch{blocked=true}
console.log(JSON.stringify({name:'addon_only_unlocks_offday',http:res.status,plan:await planFor('org_audit'),expectedBlocked:true,actualBlocked:blocked}));
database.close();
rmSync(auditDir, { recursive: true, force: true });
