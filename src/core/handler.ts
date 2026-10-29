import { nextPastDueSince } from './access';
import { customDataOf, itemsOf, parseEvent, type NormalisedEvent } from './events';
import { ownershipPredicate } from './owns';
import { verifySignature } from './signature';
import type {
  Adjustment, AdjustmentContext, ErrorContext, EventStatus, HookContext, Logger, OwnsPredicate, OwnsResolver, ReasonCode, Store, Transaction,
  UnverifiedStats,
} from './types';

export interface HandlerDeps {
  store: Store;
  /** One secret, or several during a rotation. */
  secret: string | readonly string[];
  toleranceSeconds: number;
  /** How far ahead of the server clock a signature's timestamp may be. Default 60. */
  futureSkewSeconds?: number;
  log: Logger;
  now: () => Date;
  /** How long a `received` claim blocks duplicate deliveries before it counts as a crashed attempt. Default 60. */
  leaseSeconds?: number;
  onTransaction?: (tx: Transaction, ctx: HookContext) => Promise<void> | void;
  onAdjustment?: (adj: Adjustment, ctx: AdjustmentContext) => Promise<void> | void;
  /** From `ownershipPredicate(config.owns)`, or a resolver awaited per event; null = every event is ours. */
  owns?: OwnsPredicate | OwnsResolver | null;
  /** Largest body read, in bytes. Default `MAX_WEBHOOK_BODY_BYTES`. */
  maxBodyBytes?: number;
  /** Gets the original error of a failed hook, `owns`, price lookup or store call. Never called for refused requests. */
  onError?: (error: unknown, ctx: ErrorContext) => void;
  /** A hook (or `owns`) that runs longer fails the event as `hook_error`. Unset: no limit. */
  hookTimeoutMs?: number;
  /** Counts requests refused before the signature is verified. Default: a counter of this handler's own. */
  unverified?: UnverifiedCounter;
}

/** Default body cap: just under Vercel's 4.5 MB request limit. A body over it gets 413 `body_too_large`, unread past the cap. */
export const MAX_WEBHOOK_BODY_BYTES = 4_000_000;

/** The body as text, or null when it is over `max` bytes. Stops reading at the cap; decodes once, as `req.text()` does. */
async function readBody(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get('content-length')) > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    size += r.value.byteLength;
    if (size > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(r.value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(bytes); // UTF-8, BOM stripped, bad bytes replaced: the same text as req.text()
}

/** A failure with its own reason (`hook_error`, `prices_unavailable`), so it is not mistaken for a store failure. */
class Failure extends Error {
  constructor(readonly reason: ReasonCode, readonly original: unknown) {
    super(reason); // the original error may carry secrets: only onError ever sees it
  }
}

export class TimeoutError extends Error {
  override name = 'TimeoutError';
}

/** `p`, or a TimeoutError after `ms`. The work itself is not cancelled. No `ms`: `p` as is. */
export function within<T>(p: Promise<T>, ms: number | undefined, what: string): Promise<T> {
  if (!ms) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${what} took longer than ${ms} ms`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** Every method of `store` with a time limit (a TimeoutError is a store failure). */
export function timedStore(store: Store, ms: number | undefined): Store {
  if (!ms) return store;
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => within(Promise.resolve(value.apply(target, args)), ms, `store.${String(prop)}`);
    },
  });
}

/** Calls `onError`; a throwing or rejecting `onError` never changes the answer. */
export function report(onError: HandlerDeps['onError'], error: unknown, ctx: ErrorContext): void {
  if (!onError) return;
  try {
    void Promise.resolve(onError(error, ctx)).catch(() => {});
  } catch {
    /* the app's error reporter failed: nothing more to do */
  }
}

export interface UnverifiedCounter {
  add(reason: ReasonCode): void;
  stats(): UnverifiedStats;
}

/** In-memory count of refused, unverified requests, with at most one warn line a minute (carrying the count since the last). */
export function unverifiedCounter(log: Logger, now: () => Date): UnverifiedCounter {
  const stats: UnverifiedStats = { since: now().toISOString(), count: 0, byReason: {}, lastAt: null, lastReason: null };
  let loggedAt = Number.NEGATIVE_INFINITY;
  let unlogged = 0;
  return {
    add(reason) {
      const at = now();
      stats.count++;
      stats.byReason[reason] = (stats.byReason[reason] ?? 0) + 1;
      stats.lastAt = at.toISOString();
      stats.lastReason = reason;
      unlogged++;
      if (at.getTime() - loggedAt >= 60_000) {
        log({ level: 'warn', reason, count: unlogged });
        loggedAt = at.getTime();
        unlogged = 0;
      }
    },
    stats: () => ({ ...stats, byReason: { ...stats.byReason } }),
  };
}

/** Labels of normal traffic on a shared seller account: recorded, never a warn line. */
const QUIET: ReadonlySet<ReasonCode> = new Set(['unknown_event', 'not_ours', 'unmatched', 'mirrored']);

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function createWebhookHandler(d: HandlerDeps): (req: Request) => Promise<Response> {
  const unverified = d.unverified ?? unverifiedCounter(d.log, d.now);

  /** Refused before the signature is verified: counted in memory only. Anyone can send these; none may touch the store. */
  function refuse(reason: ReasonCode, status: number): Response {
    unverified.add(reason);
    return json({ error: reason }, status);
  }

  /** Refused after the signature was verified (only Paddle, or someone with the secret, gets here): recorded in the store. */
  async function reject(reason: ReasonCode, status: number): Promise<Response> {
    d.log({ level: 'warn', reason });
    try {
      await d.store.recordFailure(reason, d.now());
    } catch (error) {
      d.log({ level: 'error', reason: 'store_error' });
      report(d.onError, error, { reason: 'store_error' });
    }
    return json({ error: reason }, status);
  }

  async function runHook(hook: (() => Promise<void> | void) | undefined): Promise<void> {
    if (!hook) return;
    try {
      await within(Promise.resolve().then(hook), d.hookTimeoutMs, 'hook');
    } catch (error) {
      throw new Failure('hook_error', error);
    }
  }

  const NOT_OURS = { status: 'ignored', reason: 'not_ours' } as const;
  async function matches(x: Parameters<OwnsPredicate>[0]): Promise<boolean> {
    const owns = d.owns;
    if (!owns) return true;
    let predicate: OwnsPredicate;
    if (typeof owns === 'function') predicate = owns;
    else {
      try {
        // No id found must never read as "not ours": fail the event (503) so Paddle retries.
        predicate = ownershipPredicate((await within(Promise.resolve().then(() => owns.resolve()), d.hookTimeoutMs, 'owns.resolve')) ?? {})!;
      } catch (error) {
        throw new Failure('prices_unavailable', error);
      }
    }
    try {
      return predicate(x) === true;
    } catch (error) {
      throw new Failure('hook_error', error); // user code, like a hook: fail the event so Paddle retries
    }
  }

  async function apply(ev: NormalisedEvent): Promise<{ status: EventStatus; reason: ReasonCode | null }> {
    switch (ev.kind) {
      case 'subscription': {
        const prev = await d.store.getSubscription(ev.subscription.subscriptionId);
        const ours = await matches({ kind: 'subscription', items: itemsOf(ev.subscription), customData: customDataOf(ev.subscription) });
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
      case 'transaction': {
        const tx = ev.transaction;
        const ours = await matches({ kind: 'transaction', items: tx.items, customData: tx.customData });
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
        const ours = sub ? await matches({ kind: 'subscription', items: itemsOf(sub), customData: customDataOf(sub) }) : seen?.owned === true;
        await runHook(d.onAdjustment && (() => d.onAdjustment!(ev.adjustment, ctx)));
        return { status: 'processed', reason: !ctx.known ? 'unmatched' : ours ? null : 'mirrored' };
      }
      case 'ignored':
        return { status: 'ignored', reason: 'unknown_event' };
    }
  }

  return async function handle(req: Request): Promise<Response> {
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    let rawBody: string | null;
    try {
      rawBody = await readBody(req, d.maxBodyBytes ?? MAX_WEBHOOK_BODY_BYTES);
    } catch {
      return refuse('missing_body', 400);
    }
    if (rawBody === null) return refuse('body_too_large', 413);
    if (!rawBody) return refuse('missing_body', 400);

    const verified = await verifySignature({
      rawBody,
      header: req.headers.get('paddle-signature'),
      secret: d.secret,
      toleranceSeconds: d.toleranceSeconds,
      futureSkewSeconds: d.futureSkewSeconds,
      now: d.now().getTime(),
    });
    if (!verified.ok) return refuse(verified.reason, verified.reason === 'bad_signature_header' ? 400 : 401);

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
      const reason: ReasonCode = err instanceof Failure ? err.reason : 'store_error';
      d.log({ level: 'error', reason, ...tag });
      report(d.onError, err instanceof Failure ? err.original : err, { reason, ...tag });
      try {
        if (!recorded) throw new Error('event row never written');
        await d.store.markEvent(ev.eventId, 'failed', reason);
      } catch {
        if (reason !== 'store_error') d.log({ level: 'error', reason: 'store_error', ...tag });
        try {
          await d.store.recordFailure(reason, d.now());
        } catch {
          /* store fully down: the log line above is the only record */
        }
      }
      // 503 for a price lookup that failed: the app is up but cannot tell yet whether the event is its own.
      return json({ error: reason }, reason === 'prices_unavailable' ? 503 : 500);
    }
  };
}
