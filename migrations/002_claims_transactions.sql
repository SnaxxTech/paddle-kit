CREATE TABLE IF NOT EXISTS paddle_event_claims (
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
