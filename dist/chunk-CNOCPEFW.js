// src/core/schema.ts
var REQUIRED_SCHEMA = {
  paddle_events: ["event_id", "event_type", "occurred_at", "received_at", "status", "reason"],
  paddle_failures: ["bucket", "reason", "hits", "last_at"],
  paddle_subscriptions: [
    "subscription_id",
    "customer_id",
    "user_id",
    "status",
    "price_ids",
    "current_period_end",
    "scheduled_change",
    "canceled_at",
    "past_due_since",
    "last_event_at",
    "raw",
    "updated_at"
  ],
  paddle_transactions: ["transaction_id", "owned", "subscription_id", "customer_id", "occurred_at", "received_at"],
  paddle_recovery: ["name", "run_id", "status", "started_at", "finished_at", "last_succeeded_at", "checkpoint_at", "lease_until", "reason"],
  paddle_event_leases: ["event_id", "claimed_at", "claim_token"],
  paddle_owned_ids: ["id", "kind", "first_seen_at"],
  paddle_recovery_progress: ["name", "run_id", "window_from", "window_to", "phase", "cursor", "updated_at"]
};
var FULFILMENT_SCHEMA = {
  paddle_fulfilments: ["transaction_id", "user_id", "grants", "state", "taken", "created_at", "updated_at"],
  paddle_fulfilment_adjustments: ["adjustment_id", "transaction_id", "action", "type", "status", "rank"],
  paddle_fulfilment_reviews: ["id", "transaction_id", "kind", "detail", "created_at", "resolved_at"],
  paddle_outbox: ["id", "kind", "payload", "attempts", "next_at", "last_error", "sent_at", "created_at"]
};
var MIGRATION_OF_TABLE = {
  paddle_fulfilments: "005_fulfilment_outbox",
  paddle_fulfilment_adjustments: "005_fulfilment_outbox",
  paddle_fulfilment_reviews: "005_fulfilment_outbox",
  paddle_outbox: "005_fulfilment_outbox",
  paddle_events: "001_init",
  paddle_failures: "001_init",
  paddle_subscriptions: "001_init",
  paddle_transactions: "002_claims_transactions",
  paddle_recovery: "003_recovery",
  paddle_event_leases: "004_claim_tokens_owned_ids",
  paddle_owned_ids: "004_claim_tokens_owned_ids",
  paddle_recovery_progress: "006_recovery_progress"
};
function missingSchema(found, extra = {}) {
  const missing = [];
  for (const [table, columns] of Object.entries({ ...REQUIRED_SCHEMA, ...extra })) {
    const have = found.get(table);
    if (!have) missing.push(table);
    else for (const c of columns) if (!have.has(c)) missing.push(`${table}.${c}`);
  }
  return missing;
}

export {
  REQUIRED_SCHEMA,
  FULFILMENT_SCHEMA,
  MIGRATION_OF_TABLE,
  missingSchema
};
