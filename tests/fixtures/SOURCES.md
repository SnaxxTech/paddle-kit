# Fixture sources

Captured 2026-10-15. The Paddle sandbox webhook simulator was not available (the sandbox MCP key was rejected, HTTP 401),
so these are the "Example" payloads published on Paddle's webhook reference pages (brief source 2). Each page was fetched
as Markdown by appending `.md`, the JSON block under the `## Example` heading was extracted and re-serialised with
2-space indentation. No values were changed except where noted. The docs examples are dated April 2024.

| File | Source |
|---|---|
| subscription.created.json | https://developer.paddle.com/webhooks/subscriptions/subscription-created.md |
| subscription.updated.json | https://developer.paddle.com/webhooks/subscriptions/subscription-updated.md |
| subscription.canceled.json | https://developer.paddle.com/webhooks/subscriptions/subscription-canceled.md |
| customer.created.json | https://developer.paddle.com/webhooks/customers/customer-created.md |
| transaction.completed.json | https://developer.paddle.com/webhooks/transactions/transaction-completed.md |

## Edits

- `subscription.created.json`: `data.custom_data` set to `{"userId":"user_1"}` (original value in the docs example: `null`). This is the only edit.

## Parser vs fixture differences

None. All five fixtures parse with the brief's `parseEvent` unchanged.

## Caveat

Docs examples are not captured deliveries: the envelope matches (`event_id`, `event_type`, `occurred_at`, `notification_id`, `data`),
but they are curated samples. Replace with simulator captures once sandbox access works.
