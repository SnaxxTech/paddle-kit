import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../fixtures/', import.meta.url));

export function loadFixture(name: string): any {
  return JSON.parse(readFileSync(`${dir}${name}.json`, 'utf8'));
}

/** A real subscription.created payload with selected envelope/data fields overridden. */
export function subscriptionEvent(o: { eventId?: string; eventType?: string; occurredAt?: string; data?: Record<string, unknown> } = {}): any {
  const base = loadFixture('subscription.created');
  return {
    ...base,
    event_id: o.eventId ?? base.event_id,
    event_type: o.eventType ?? base.event_type,
    occurred_at: o.occurredAt ?? base.occurred_at,
    data: { ...base.data, ...(o.data ?? {}) },
  };
}
