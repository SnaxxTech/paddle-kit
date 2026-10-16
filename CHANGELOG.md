# Changelog

## 0.3.0 (unreleased)

Additive; every v0.2 test passes unchanged except the one assertion about the event kind of `transaction.completed`.

- New normalised event kinds `transaction` and `adjustment`, and optional `onTransaction` / `onAdjustment` hooks in `createBilling`.
  Hooks run at least once per verified event, after the event is recorded and before it is marked processed.
  `onTransaction` fires only for `transaction.completed`; `transaction.paid` is recorded without a hook.
  `Transaction` and `Adjustment` carry `total` (tax-inclusive) and `subtotal` (pre-tax) as lowest-unit strings.
- `itemsOf(subscription)` and `customDataOf(subscription)` read line items (price, product, quantity) and the full custom data from a stored subscription.
- Behaviour change: `transaction.paid`, `adjustment.created` and `adjustment.updated` are now `processed` (record-only without hooks); in v0.2 they were stored as `ignored`.
- Behaviour change: a `transaction.*` payload without `data.id`, or an `adjustment.*` payload without `data.id` or `data.transaction_id`, now answers 400 `bad_payload`. In v0.2 a `transaction.completed` without `data.id` was processed.
- New reason code `hook_error`: a throwing hook fails the event (HTTP 500, visible in health) so Paddle retries. Store failures keep `store_error`.
- `createCheckout().open({ customData })`: extra custom data is sent with the checkout; `userId` always comes from `userId` and cannot be overridden.
