CREATE TABLE IF NOT EXISTS paddle_event_claims (
  event_id text PRIMARY KEY,
  claimed_at timestamptz NOT NULL
);
