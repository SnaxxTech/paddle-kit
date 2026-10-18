import { nextPastDueSince } from './access';
import { customDataOf, itemsOf, parseEvent, type NormalisedEvent } from './events';
import { verifySignature } from './signature';
import type { Adjustment, AdjustmentContext, EventStatus, HookContext, Logger, OwnsPredicate, ReasonCode, Store, Transaction } from './types';

export interface HandlerDeps {
  store: Store;
  secret: string;
  toleranceSeconds: number;
  log: Logger;
  now: () => Date;
  /** How long a `received` claim blocks duplicate deliveries before it counts as a crashed attempt. Default 60. */
  leaseSeconds?: number;
  onTransaction?: (tx: Transaction, ctx: HookContext) => Promise<void> | void;
  onAdjustment?: (adj: Adjustment, ctx: AdjustmentContext) => Promise<void> | void;
  /** From `ownershipPredicate(config.owns)`; null = every event is ours. */
  owns?: OwnsPredicate | null;
}

/** Marks an error thrown by a user hook, so it is not mistaken for a store failure. */
class HookFailure extends Error {}

/** Labels of normal traffic on a shared seller account: recorded, never a warn line. */
const QUIET: ReadonlySet<ReasonCode> = new Set(['unknown_event', 'not_ours', 'unmatched', 'mirrored']);

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

  const NOT_OURS = { status: 'ignored', reason: 'not_ours' } as const;
  function matches(x: Parameters<OwnsPredicate>[0]): boolean {
    if (!d.owns) return true;
    try {
      return d.owns(x) === true;
    } catch {
      throw new HookFailure('owns threw'); // user code, like a hook: fail the event so Paddle retries
    }
  }

  async function apply(ev: NormalisedEvent): Promise<{ status: EventStatus; reason: ReasonCode | null }> {
    switch (ev.kind) {
      case 'subscription': {
        const prev = await d.store.getSubscription(ev.subscription.subscriptionId);
        const ours = matches({ kind: 'subscription', items: itemsOf(ev.subscription), customData: customDataOf(ev.subscription) });
        // A subscription already in the mirror stays ours, so a later item change can never strand a stale row.
        if (!prev && !ours) return NOT_OURS;
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
        // kept only because it is mirrored: processed as before, but no proof that owns matches (Health.lastOwnedAt)
        if (!ours) return { status: 'processed', reason: 'mirrored' };
        return { status: 'processed', reason: ev.subscription.userId ? null : 'no_user_id' };
      }
      case 'customer': {
        const { applied } = await d.store.upsertCustomer(ev.customer);
        // no line items, so owns never checks it: `unmatched`
        return applied ? { status: 'processed', reason: 'unmatched' } : { status: 'stale', reason: 'out_of_order' };
      }
      case 'transaction': {
        const tx = ev.transaction;
        const ours = matches({ kind: 'transaction', items: tx.items, customData: tx.customData });
        const owned = ours || (tx.subscriptionId !== null && (await d.store.getSubscription(tx.subscriptionId)) !== null);
        // Remembered either way, so a later refund of it can be told apart from a refund of a payment not seen yet.
        await d.store.recordTransaction?.({
          transactionId: tx.transactionId, owned, subscriptionId: tx.subscriptionId, customerId: tx.customerId,
          occurredAt: tx.occurredAt, receivedAt: d.now().toISOString(),
        });
        if (!owned) return NOT_OURS;
        // transaction.paid is record-only: the hook fires once, on transaction.completed (Paddle's fully-processed signal)
        if (ev.eventType === 'transaction.completed') {
          const ctx: HookContext = { eventId: ev.eventId, eventType: ev.eventType, store: d.store };
          await runHook(d.onTransaction && (() => d.onTransaction!(ev.transaction, ctx)));
        }
        return { status: 'processed', reason: ours ? null : 'mirrored' };
      }
      case 'adjustment': {
        const adj = ev.adjustment;
        const seen = (await d.store.getTransaction?.(adj.transactionId)) ?? null;
        const sub = adj.subscriptionId === null ? null : await d.store.getSubscription(adj.subscriptionId);
        const onOurSubscription = sub !== null;
        // Only a transaction we saw and know is someone else's is filtered. An unseen one may be ours and early: keep it.
        if (seen && !seen.owned && !onOurSubscription) return NOT_OURS;
        const ctx: AdjustmentContext = { eventId: ev.eventId, eventType: ev.eventType, store: d.store, known: seen?.owned === true || onOurSubscription };
        // owns matched what it adjusts: the mirrored subscription's items, or a one-time payment seen as ours
        const ours = sub ? matches({ kind: 'subscription', items: itemsOf(sub), customData: customDataOf(sub) }) : seen?.owned === true;
        await runHook(d.onAdjustment && (() => d.onAdjustment!(ev.adjustment, ctx)));
        return { status: 'processed', reason: !ctx.known ? 'unmatched' : ours ? null : 'mirrored' };
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
      const at = d.now();
      const leaseExpiredBefore = new Date(at.getTime() - (d.leaseSeconds ?? 60) * 1000).toISOString();
      const claim = await d.store.recordEvent({ ...tag, occurredAt: ev.occurredAt, receivedAt: at.toISOString(), leaseExpiredBefore });
      if (claim.alreadyDone) return json({ received: true, duplicate: true }, 200);
      // Another delivery of this event is running its hooks. Not a 2xx: if that attempt fails, this retry must come back.
      if (claim.inProgress) return json({ error: 'in_progress' }, 409);
      recorded = true;
      const outcome = await apply(ev);
      await d.store.markEvent(ev.eventId, outcome.status, outcome.reason);
      if (outcome.reason && !QUIET.has(outcome.reason)) d.log({ level: 'warn', reason: outcome.reason, ...tag });
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
