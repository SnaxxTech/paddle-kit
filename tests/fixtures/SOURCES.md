# Fixture sources

Captured 2026-10-16 from real deliveries of the **Paddle sandbox webhook simulator**: Paddle signed each event with the
destination's secret and POSTed it through a cloudflared tunnel to a local server running paddle-kit, which accepted every
one (200) and wrote the raw body to disk. The JSON was re-serialised with 2-space indentation; no values were changed
except where noted. The simulator uses Paddle's demo entities (customer `jo@example.com`, a subscription whose billing
period is fixed at 2024-04-12 → 2024-05-12), so timestamps inside `data` are from 2024 while `occurred_at` is 2026.

| File | Simulator run |
|---|---|
| customer.created.json | scenario `subscription_creation` |
| subscription.created.json | scenario `subscription_creation` |
| transaction.completed.json | scenario `subscription_creation` |
| subscription.updated.json | scenario `subscription_renewal`, payment outcome `failed` (first event: status still `active`) |
| subscription.past_due.json | scenario `subscription_renewal`, payment outcome `failed` |
| subscription.canceled.json | scenario `subscription_renewal`, payment outcome `failed`, dunning exhausted → `subscription_canceled` |

## Edits

- `subscription.created.json`: `data.custom_data` set to `{"userId":"user_1"}` (the simulator sends `null`). This is the only edit.

## Compared with the previous fixtures

The previous fixtures were the "Example" payloads from Paddle's webhook reference docs (April 2024). Subscription and
customer payloads have exactly the same fields as those examples. `transaction.completed` differs only in payout totals
(`details.adjusted_payout_totals` present, some `payout_totals` fields absent), which paddle-kit does not read.

## What these do not show

The simulator's renewal scenario keeps the demo subscription's billing period fixed, so these payloads cannot show whether
`current_billing_period` advances when a real renewal fails. That needs a real sandbox checkout followed by a renewal.
