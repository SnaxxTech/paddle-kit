# Can the browser edit a checkout that the server created? (sandbox test, 2026-11-12)

**Answer: yes.** A buyer can replace the custom data and the items of a server-created transaction from the browser,
before paying. `createCheckoutTransaction` does not lock a checkout.

## Why we tested it

Until v0.9.3 the README and `src/server/index.ts` said that with a transaction created on the server "the browser
then cannot change who is paid for or what is bought". Paddle's documentation says the opposite: customers can edit a
transaction's items unless it is `billed`, and `Paddle.Checkout.updateCheckout({ customData })` replaces existing
custom data. We ran the test to know, not to infer.

## What we ran

Paddle sandbox account, kit v0.9.3, Paddle.js v2 from `cdn.paddle.com`, a page on `http://localhost:8765`, an existing
sandbox client-side token. No payment was made.

1. Server (Paddle API, the same request body as `createCheckoutTransaction`): `POST /transactions` with one item
   (QR Lab "25 dynamic QR codes", USD 49.00), `collection_mode: "automatic"`,
   `custom_data: { userId: "user_server_decided", orderRef: "server_order_1" }`. Result: `txn_01m7875vwqq9m5p5w4mhjtm04d`,
   status `draft`, origin `api`.
2. Browser: `Paddle.Checkout.open({ transactionId })`. The `checkout.loaded` event showed the server's item and
   custom data.
3. Browser: `Paddle.Checkout.updateCheckout({ customData: { userId: "attacker_chosen_user", orderRef: "tampered", plan: "enterprise" } })`.
4. Browser: `Paddle.Checkout.updateCheckout({ items: [{ priceId: <QR Lab "1 dynamic QR code">, quantity: 3 }] })`.
5. Browser: `Paddle.Checkout.updateCheckout({ items: [{ priceId: <LeakScan "one full scan", another app on the same seller account>, quantity: 1 }] })`.
6. Server: `GET /transactions/{id}` after steps 3 and 5.
7. The same with a second transaction created with a customer and an address (status `ready`,
   `txn_01m7878wq1kcsy73gy7j7h5803`): one `updateCheckout` call with new custom data and a cheaper item.
8. Both test transactions were set to `canceled`.

## What we saw

| Step | Read from | Result |
|---|---|---|
| 3 | `checkout.updated` event, then the API | `custom_data` is `{ userId: "attacker_chosen_user", orderRef: "tampered", plan: "enterprise" }`. The server's values are gone. |
| 4 | `checkout.updated` event | Items are one line: the USD 4.99 price, quantity 3. Total fell from 57.82 to 17.66 (tax included). |
| 5 | `checkout.updated` event, then the API | Items are one line: the other app's USD 16.00 price. `details.totals.grand_total` is `1600`. Status still `draft`, origin still `api`. |
| 7 | `checkout.updated` event, then the API | Status `ready`: `custom_data` is `{ userId: "attacker_chosen_user" }`, the item is the USD 4.99 price, `grand_total` is `589`. |

Every row was observed in this run. Not tested: paying for an edited transaction (the completed transaction is
expected to carry the edited data; **UNVERIFIED**), a transaction in status `billed`, and live mode.

## What it means for an app

- The buyer always pays for the items that end up on the transaction. Grant by the line items (price id, quantity) of
  the completed transaction, as the starters do. Then an edit cannot get more than was paid for.
- `custom_data.userId` says who the buyer wants to receive the purchase. A buyer can point it at another user: the
  result is a paid gift, not a theft.
- Never read a plan, a seat count, an amount, an order reference or a permission from `custom_data`.
- `allowedPriceIds` checks the request before Paddle is called. It does not limit what the buyer finally pays for.
  A price that must not be sold has to be archived in Paddle.
- On a shared seller account a checkout opened by one app can end with another app's price (observed, step 5). If
  the buyer then pays, that other app's webhook is expected to receive a normal paid transaction for its own price,
  with custom data the buyer chose (**UNVERIFIED**: no edited transaction was paid in this run).

## Not built (a possible later step)

A real binding of a payment to the signed-in user needs the server to remember "transaction id → user" when it
creates the transaction, and the hook to use that record instead of `custom_data`. In this run the transaction id
stayed the same through every edit; an attempt to change it from the browser was not made (**UNVERIFIED**). A
transaction the server did not create would have no record, so the hook would not grant it. This needs a new table and a migration; it is not in the kit today.

## Run it again

Serve this page on localhost, open it with `?t=<sandbox client-side token>`, then in the console call
`openTxn("<txn id from POST /transactions>")` and `edit({ customData: { userId: "x" } })`, and read the transaction
from the API.

```html
<!doctype html>
<meta charset="utf-8">
<pre id="log"></pre>
<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>
<script>
  const note = (name, d) => {
    document.getElementById('log').textContent += JSON.stringify({ name, txn: d?.transaction_id, status: d?.status,
      custom_data: d?.custom_data, items: (d?.items || []).map((i) => ({ price_id: i.price_id, quantity: i.quantity })),
      total: d?.totals?.total }) + '\n';
  };
  Paddle.Environment.set('sandbox');
  Paddle.Initialize({ token: new URLSearchParams(location.search).get('t'), eventCallback: (e) => note(e.name, e.data) });
  window.openTxn = (id) => Paddle.Checkout.open({ transactionId: id });
  window.edit = (o) => Paddle.Checkout.updateCheckout(o);
</script>
```
