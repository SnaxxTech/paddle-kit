// Audit reproduction: copy into the reviewed app at the path documented in 2026-10-30-paddle-kit-review.md.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
process.env.PGLITE_DATA_DIR='memory://';
delete process.env.DATABASE_URL;
import { getDb } from '@/db';
import { getOrder } from '@/lib/data/orders';
import { transactionFromApi } from '@/lib/payments';
import { applyAdjustment, fulfilFullScanPayment } from './fulfil';
import { completed, configureBilling, newOrder, PRICE } from './test-fixtures';
import type { Adjustment } from 'paddle-kit/core';
beforeAll(async()=>{await getDb()});
beforeEach(()=>configureBilling());
async function paid(){const f=await newOrder();const payment=completed(f);await fulfilFullScanPayment(transactionFromApi(JSON.parse(payment.body).data),PRICE,{source:'webhook'});return {...f,txnId:payment.txnId};}
const adj=(tx:string,id:string,action:string,status='approved'):Adjustment=>({adjustmentId:id,transactionId:tx,action,status,type:'full',subscriptionId:null,customerId:null,currency:'USD',total:'4900',subtotal:'4900',occurredAt:'2026-10-29T12:00:00Z',raw:{}});
describe('AUDIT desired adjustment invariants',()=>{
 it('a second event for an old chargeback cannot undo its later reversal',async()=>{
  const f=await paid();
  const cb=adj(f.txnId,'adj_cb_audit_1','chargeback');
  await applyAdjustment(cb);
  await applyAdjustment(adj(f.txnId,'adj_rev_audit_1','chargeback_reverse'));
  expect((await getOrder(f.orgId,f.orderId))?.status).toBe('paid');
  await applyAdjustment(cb);
  expect((await getOrder(f.orgId,f.orderId))?.status).toBe('paid');
 });
 it('a won dispute delivered before its older chargeback must stay won',async()=>{
  const f=await paid();
  await applyAdjustment({...adj(f.txnId,'adj_rev_audit_2','chargeback_reverse'),occurredAt:'2026-10-30T12:00:00Z'});
  await applyAdjustment(adj(f.txnId,'adj_cb_audit_2','chargeback'));
  expect((await getOrder(f.orgId,f.orderId))?.status).toBe('paid');
 });
});
