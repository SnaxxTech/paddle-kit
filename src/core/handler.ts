import { nextPastDueSince } from './access';
import { parseEvent, type NormalisedEvent } from './events';
import { verifySignature } from './signature';
import type { EventStatus, Logger, ReasonCode, Store } from './types';

export interface HandlerDeps {
  store: Store;
  secret: string;
  toleranceSeconds: number;
  log: Logger;
  now: () => Date;
}

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

  async function apply(ev: NormalisedEvent): Promise<{ status: EventStatus; reason: ReasonCode | null }> {
    switch (ev.kind) {
      case 'subscription': {
        const prev = await d.store.getSubscription(ev.subscription.subscriptionId);
        const pastDueSince = nextPastDueSince(prev, ev.subscription.status, ev.occurredAt);
        const { applied } = await d.store.upsertSubscription({ ...ev.subscription, pastDueSince });
        if (!applied) return { status: 'stale', reason: 'out_of_order' };
        return { status: 'processed', reason: ev.subscription.userId ? null : 'no_user_id' };
      }
      case 'customer': {
        const { applied } = await d.store.upsertCustomer(ev.customer);
        return applied ? { status: 'processed', reason: null } : { status: 'stale', reason: 'out_of_order' };
      }
      case 'record-only':
        return { status: 'processed', reason: null };
      case 'ignored':
        return { status: 'ignored', reason: 'unknown_event' };
    }
  }

  return async function handle(req: Request): Promise<Response> {
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const rawBody = await req.text();
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
    try {
      const { alreadyDone } = await d.store.recordEvent({ ...tag, occurredAt: ev.occurredAt, receivedAt: d.now().toISOString() });
      if (alreadyDone) return json({ received: true, duplicate: true }, 200);
      const outcome = await apply(ev);
      await d.store.markEvent(ev.eventId, outcome.status, outcome.reason);
      if (outcome.reason && outcome.reason !== 'unknown_event') d.log({ level: 'warn', reason: outcome.reason, ...tag });
      return json({ received: true }, 200);
    } catch {
      d.log({ level: 'error', reason: 'store_error', ...tag });
      try {
        await d.store.markEvent(ev.eventId, 'failed', 'store_error');
      } catch {
        try {
          await d.store.recordFailure('store_error', d.now());
        } catch {
          /* store fully down: the log line above is the only record */
        }
      }
      return json({ error: 'store_error' }, 500);
    }
  };
}
