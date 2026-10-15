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
];
