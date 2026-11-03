export const MIGRATIONS: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: '001_init',
    sql: `CREATE TABLE IF NOT EXISTS paddle_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  status text NOT NULL,
  reason text
);
CREATE INDEX IF NOT EXISTS paddle_events_received_at_idx ON paddle_events (received_at);

CREATE TABLE IF NOT EXISTS paddle_failures (
  bucket timestamptz NOT NULL,
  reason text NOT NULL,
  hits integer NOT NULL,
  last_at timestamptz NOT NULL,
  PRIMARY KEY (bucket, reason)
);

CREATE TABLE IF NOT EXISTS paddle_customers (
  customer_id text PRIMARY KEY,
  email text,
  last_event_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paddle_subscriptions (
  subscription_id text PRIMARY KEY,
  customer_id text NOT NULL,
  user_id text,
  status text NOT NULL,
  price_ids jsonb NOT NULL,
  current_period_end timestamptz,
  scheduled_change jsonb,
  canceled_at timestamptz,
  past_due_since timestamptz,
  last_event_at timestamptz NOT NULL,
  raw jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paddle_subscriptions_user_id_idx ON paddle_subscriptions (user_id);
`,
  },
  {
    name: '002_claims_transactions',
    sql: `CREATE TABLE IF NOT EXISTS paddle_event_claims (
  event_id text PRIMARY KEY,
  claimed_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS paddle_transactions (
  transaction_id text PRIMARY KEY,
  owned boolean NOT NULL,
  subscription_id text,
  customer_id text,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL
);
`,
  },
  {
    name: '003_recovery',
    sql: `CREATE TABLE IF NOT EXISTS paddle_recovery (
  name text PRIMARY KEY,
  run_id text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  last_succeeded_at timestamptz,
  checkpoint_at timestamptz,
  lease_until timestamptz,
  reason text
);
CREATE INDEX IF NOT EXISTS paddle_events_unfinished_idx ON paddle_events (received_at)
  WHERE status IN ('received', 'failed');
`,
  },
  {
    name: '004_claim_tokens_owned_ids',
    // A new claims table instead of ALTER TABLE: migrations stay CREATE-only. paddle_event_claims is no longer used.
    sql: `CREATE TABLE IF NOT EXISTS paddle_event_leases (
  event_id text PRIMARY KEY,
  claimed_at timestamptz NOT NULL,
  claim_token text
);

CREATE TABLE IF NOT EXISTS paddle_owned_ids (
  id text PRIMARY KEY,
  kind text NOT NULL,
  first_seen_at timestamptz NOT NULL
);
`,
  },
  {
    name: '005_fulfilment_outbox',
    // Used only by paddle-kit/fulfil (since v0.8.6); harmless and empty for apps that do not use it. Postgres only.
    sql: `CREATE TABLE IF NOT EXISTS paddle_fulfilments (
  transaction_id text PRIMARY KEY,
  user_id text NOT NULL,
  grants jsonb NOT NULL,
  state text NOT NULL,
  taken jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paddle_fulfilment_adjustments (
  adjustment_id text PRIMARY KEY,
  transaction_id text NOT NULL,
  action text NOT NULL,
  type text,
  status text NOT NULL,
  rank int NOT NULL
);
CREATE INDEX IF NOT EXISTS paddle_fulfilment_adjustments_txn_idx ON paddle_fulfilment_adjustments (transaction_id);

CREATE TABLE IF NOT EXISTS paddle_fulfilment_reviews (
  id text PRIMARY KEY,
  transaction_id text NOT NULL,
  kind text NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE IF NOT EXISTS paddle_outbox (
  id text PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paddle_outbox_due_idx ON paddle_outbox (next_at) WHERE sent_at IS NULL;
`,
  },
];
