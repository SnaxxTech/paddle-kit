import { nextPastDueSince } from './access';
import { parseEvent, type NormalisedEvent } from './events';
import { verifySignature } from './signature';
import type { Adjustment, EventStatus, HookContext, Logger, ReasonCode, Store, Transaction } from './types';

export interface HandlerDeps {
  store: Store;
  secret: string;
  toleranceSeconds: number;
  log: Logger;
  now: () => Date;
  onTransaction?: (tx: Transaction, ctx: HookContext) => Promise<void> | void;
  onAdjustment?: (adj: Adjustment, ctx: HookContext) => Promise<void> | void;
}

/** Marks an error thrown by a user hook, so it is not mistaken for a store failure. */
class HookFailure extends Error {}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function createWebhookHandler(d: HandlerDeps): (req: Request) => Promise<Response> {
  async function reject(reason: ReasonCode, status: number): Promise<Response> {
    d.log({ level: 'warn', reason });
    try {
      await d.store.recordFailure(reason, d.now());
    } catch {
      d.log({ level: 'error', reason: 'store_error' });
    }
    return json({ error: reason }, status);
  }

  async function runHook(hook: (() => Promise<void> | void) | undefined): Promise<void> {
    if (!hook) return;
    try {
      await hook();
    } catch {
      throw new HookFailure('hook threw'); // the original error may carry secrets: it is never logged or stored
    }
  }

  async function apply(ev: NormalisedEvent): Promise<{ status: EventStatus; reason: ReasonCode | null }> {
    switch (ev.kind) {
      case 'subscription': {
        const prev = await d.store.getSubscription(ev.subscription.subscriptionId);
        const pastDueSince = nextPastDueSince(prev, ev.subscription.status, ev.occurredAt);
        const { applied } = await d.store.upsertSubscription({ ...ev.subscription, pastDueSince });
        if (!applied) {
          if (
            ev.subscription.status === 'past_due' &&
            prev?.status === 'past_due' &&
            prev.pastDueSince &&
            Date.parse(prev.pastDueSince) > Date.parse(ev.occurredAt)
          ) {
            // an older past_due event arrived late: pull the grace clock back (same lastEventAt applies)
            await d.store.upsertSubscription({ ...prev, pastDueSince: ev.occurredAt });
          }
          return { status: 'stale', reason: 'out_of_order' };
        }
        return { status: 'processed', reason: ev.subscription.userId ? null : 'no_user_id' };
      }
      case 'customer': {
        const { applied } = await d.store.upsertCustomer(ev.customer);
        return applied ? { status: 'processed', reason: null } : { status: 'stale', reason: 'out_of_order' };
      }
      case 'transaction': {
        const ctx: HookContext = { eventId: ev.eventId, eventType: ev.eventType, store: d.store };
        await runHook(d.onTransaction && (() => d.onTransaction!(ev.transaction, ctx)));
        return { status: 'processed', reason: null };
      }
      case 'adjustment': {
        const ctx: HookContext = { eventId: ev.eventId, eventType: ev.eventType, store: d.store };
        await runHook(d.onAdjustment && (() => d.onAdjustment!(ev.adjustment, ctx)));
        return { status: 'processed', reason: null };
      }
      case 'ignored':
        return { status: 'ignored', reason: 'unknown_event' };
    }
  }

  return async function handle(req: Request): Promise<Response> {
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    let rawBody: string;
    try {
      rawBody = await req.text();
    } catch {
      return reject('missing_body', 400);
    }
    if (!rawBody) return reject('missing_body', 400);

    const verified = await verifySignature({
      rawBody,
      header: req.headers.get('paddle-signature'),
      secret: d.secret,
      toleranceSeconds: d.toleranceSeconds,
      now: d.now().getTime(),
    });
    if (!verified.ok) return reject(verified.reason, verified.reason === 'bad_signature_header' ? 400 : 401);

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return reject('bad_json', 400);
    }
    const ev = parseEvent(parsed);
    if (!ev) return reject('bad_payload', 400);

    const tag = { eventId: ev.eventId, eventType: ev.eventType };
    let recorded = false;
    try {
      const { alreadyDone } = await d.store.recordEvent({ ...tag, occurredAt: ev.occurredAt, receivedAt: d.now().toISOString() });
      recorded = true;
      if (alreadyDone) return json({ received: true, duplicate: true }, 200);
      const outcome = await apply(ev);
      await d.store.markEvent(ev.eventId, outcome.status, outcome.reason);
      if (outcome.reason && outcome.reason !== 'unknown_event') d.log({ level: 'warn', reason: outcome.reason, ...tag });
      return json({ received: true }, 200);
    } catch (err) {
      const reason: ReasonCode = err instanceof HookFailure ? 'hook_error' : 'store_error';
      d.log({ level: 'error', reason, ...tag });
      try {
        if (!recorded) throw new Error('event row never written');
        await d.store.markEvent(ev.eventId, 'failed', reason);
      } catch {
        if (reason === 'hook_error') d.log({ level: 'error', reason: 'store_error', ...tag });
        try {
          await d.store.recordFailure(reason === 'hook_error' ? 'hook_error' : 'store_error', d.now());
        } catch {
          /* store fully down: the log line above is the only record */
        }
      }
      return json({ error: reason }, 500);
    }
  };
}
