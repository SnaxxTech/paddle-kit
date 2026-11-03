// The tables and columns this version of the kit reads and writes, and the migration that creates each table.
// A test runs the migrations on Postgres and SQLite and fails if this list and the real schema drift apart.
// paddle_customers (unused since v0.5.0) and paddle_event_claims (unused since v0.8.0) are left out on purpose.

export const REQUIRED_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  paddle_events: ['event_id', 'event_type', 'occurred_at', 'received_at', 'status', 'reason'],
  paddle_failures: ['bucket', 'reason', 'hits', 'last_at'],
  paddle_subscriptions: [
    'subscription_id', 'customer_id', 'user_id', 'status', 'price_ids', 'current_period_end', 'scheduled_change',
    'canceled_at', 'past_due_since', 'last_event_at', 'raw', 'updated_at',
  ],
  paddle_transactions: ['transaction_id', 'owned', 'subscription_id', 'customer_id', 'occurred_at', 'received_at'],
  paddle_recovery: ['name', 'run_id', 'status', 'started_at', 'finished_at', 'last_succeeded_at', 'checkpoint_at', 'lease_until', 'reason'],
  paddle_event_leases: ['event_id', 'claimed_at', 'claim_token'],
  paddle_owned_ids: ['id', 'kind', 'first_seen_at'],
  paddle_recovery_progress: ['name', 'run_id', 'window_from', 'window_to', 'phase', 'cursor', 'updated_at'],
};

/** The tables `paddle-kit/fulfil` uses (migration 005, Postgres). Checked only for apps that use the module. */
export const FULFILMENT_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  paddle_fulfilments: ['transaction_id', 'user_id', 'grants', 'state', 'taken', 'created_at', 'updated_at'],
  paddle_fulfilment_adjustments: ['adjustment_id', 'transaction_id', 'action', 'type', 'status', 'rank'],
  paddle_fulfilment_reviews: ['id', 'transaction_id', 'kind', 'detail', 'created_at', 'resolved_at'],
  paddle_outbox: ['id', 'kind', 'payload', 'attempts', 'next_at', 'last_error', 'sent_at', 'created_at'],
};

export const MIGRATION_OF_TABLE: Readonly<Record<string, string>> = {
  paddle_fulfilments: '005_fulfilment_outbox',
  paddle_fulfilment_adjustments: '005_fulfilment_outbox',
  paddle_fulfilment_reviews: '005_fulfilment_outbox',
  paddle_outbox: '005_fulfilment_outbox',
  paddle_events: '001_init',
  paddle_failures: '001_init',
  paddle_subscriptions: '001_init',
  paddle_transactions: '002_claims_transactions',
  paddle_recovery: '003_recovery',
  paddle_event_leases: '004_claim_tokens_owned_ids',
  paddle_owned_ids: '004_claim_tokens_owned_ids',
  paddle_recovery_progress: '006_recovery_progress',
};

/** What is missing from `found` (table → its columns): `table` for a missing table, `table.column` for a column. */
export function missingSchema(found: ReadonlyMap<string, ReadonlySet<string>>, extra: Readonly<Record<string, readonly string[]>> = {}): string[] {
  const missing: string[] = [];
  for (const [table, columns] of Object.entries({ ...REQUIRED_SCHEMA, ...extra })) {
    const have = found.get(table);
    if (!have) missing.push(table);
    else for (const c of columns) if (!have.has(c)) missing.push(`${table}.${c}`);
  }
  return missing;
}
