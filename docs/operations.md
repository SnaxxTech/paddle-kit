# Operations

Reference moved out of the [README](../README.md): the resilient transport, the recovery job, the catalog CLI and monitoring.

## Resilience: the transport and the recovery job (since v0.8.0)

`billingFromEnv` wires both (Quickstart). With `createBilling` directly, keep one transport per app and Paddle
account/environment and pass it, or set `paddleFetch`:

```ts
import { createPaddleTransport } from 'paddle-kit/core';
import { recoverBilling } from 'paddle-kit/reconcile';

const paddle = createPaddleTransport();
// getPrice(priceId, { apiKey, environment, fetch: paddle.fetch });
const result = await recoverBilling(billing, { apiKey, fetch: paddle.fetch });
if (result.status === 'failed') throw new Error(`Billing recovery: ${result.reason}`);
```

`createPaddleTransport` bounds each full JSON attempt to 4 seconds and the operation (including backoff) to 10 seconds.
GETs retry at most twice on network failures, timeouts, and HTTP 408/429/500/502/503/504. Mutations are never retried
implicitly; 401/403 and other permanent errors return immediately. `Retry-After` controls the delay; if it will not fit
in the budget the caller gets the response and retries in a later job. Requests cannot follow redirects or leave the
Paddle API origins. Error messages contain no credentials or original network error text.

After three failed operations the circuit opens for 30 seconds. A 429 starts a provider cooldown immediately. Once
cooldown expires, exactly one request probes Paddle: success closes the circuit; failure opens it again. `paddle.state()`
reports `closed`, `open`, or `half_open`, failure count and retry time. This state belongs to one warm process; it is
**not** a fleet-wide rate limit. Incoming verified webhooks and local access reads do not depend on the circuit.
A serverless restart resets the circuit, so durable recovery and provider-side limits are still needed.

`recoverBilling` uses `billing.store.recovery` (all built-in stores; custom stores may provide `opts.store`). One database
lease prevents overlapping jobs; an expired lease can be reclaimed, and a replaced worker cannot overwrite its successor's
checkpoint. The default job budget is 45 seconds. Call it from an authenticated cron with a function budget of at least
60 seconds. It does not create a scheduler.

The first run scans all payment history by default (`initialSince` may explicitly set a later boundary). Later runs resume
from the last successful **start** time with an hour's overlap, including after outages longer than seven days. It retries
unfinished original events through Paddle's documented time/type-filtered event stream, repairs subscriptions, and replays
payments/adjustments through the same hooks/claims as webhooks. The checkpoint advances only after every phase succeeds.
Since v0.8.7 (migration 006) a run reads page by page and saves its window (`from`, a fixed `to`), phase and next page
after each page: a run cut off by its budget is continued by the next one instead of starting over, and the checkpoint
becomes the window's `to`. A page with a failed item stops the saving, so the next run retries from that page. Saved
progress is kept until the window completes, however long that takes (since v0.9.2).
A partial result, malformed page, page limit, timeout, or remaining eligible unfinished event keeps recovery failed.
Hook side effects remain at least once and must be idempotent. Timed-out work is aborted where the driver supports it;
non-cancellable in-flight writes may finish, so recovery never promises exactly-once execution.

Paddle retains original events for 90 days. An original event outside retention, a permanent payload problem, missing API
permissions, or a persistent business hook failure requires human attention; recovery leaves it visible instead of dropping
it. Recovery requires `notification.read`, `subscription.read`, `transaction.read` and `adjustment.read` API permissions.
Health now includes durable `unresolvedFailed` and `oldestPendingAt` signals. Doctor treats unresolved failures and events
unfinished for over five minutes as problems independently of the latest failure reason. With `staleHours`, other products'
traffic no longer hides stale owned traffic.

Built-in stores expose `applySubscription` for atomic grace transitions. A newer overdue snapshot preserves the current
clock; a recovery clears it; a later delinquency starts a fresh clock. Older snapshots never backdate it. This deliberately
permits extra grace when the first overdue event arrives out of order, rather than inferring an episode from stale data.
The low-level `upsertSubscription` API is unchanged. Custom stores without `applySubscription` retain read/write behavior
and must provide their own concurrency guarantees.

## Catalog CLI

`paddle-kit-catalog` reads a JSON file and creates or updates a **sandbox** catalog in Paddle. It makes the product, the prices, the webhook destination and a client token. Then it writes the results to an env file. A second run with the same file changes nothing.

```jsonc
// paddle.catalog.json
{ "app": "myapp",
  "product": { "name": "MyApp", "taxCategory": "saas" },
  "prices": [
    { "key": "team", "cycle": "monthly", "name": "Team (monthly)", "amount": "1000", "currency": "USD" },
    { "key": "team", "cycle": "yearly",  "name": "Team (yearly)",  "amount": "9600", "currency": "USD" },
    { "key": "pack", "cycle": "once",    "name": "5 credits",      "amount": "1499", "currency": "USD" } ] }
```

```bash
PADDLE_API_KEY=pdl_sdbx_... npx paddle-kit-catalog --catalog paddle.catalog.json --webhook-url https://my-tunnel.example.com/api/paddle
```

| Flag | Meaning |
|---|---|
| `--catalog <path>` | The catalog JSON file. Default: `paddle.catalog.json`. |
| `--webhook-url <url>` | The **full URL** of your webhook route, with the path (for example `https://host/api/paddle`). Only `https`. It turns on the destination and client-token steps. Without it, the CLI syncs only the product and the prices. |
| `--env-file <path>` | The env file. The CLI reads `PADDLE_API_KEY` from it (after the process environment) and writes the results to it. Default: `.env.local`. The file gets mode 0600. The CLI writes each key when its step is done, and does not touch other lines. |
| `--teardown` | Archive the prices and the product that this tool made, and turn off its destination. |
| `--live` | Allow a live (`pdl_live_`) key. Without this flag, the CLI refuses all keys except sandbox keys. |
| `--host vercel` | Also print the `vercel env add` commands for the host block (since v0.6.0). The CLI never runs them. |
| `--show-secrets` | Print the webhook secret in the host block. Without it, the secret is a comment that shows only its last 4 characters. |

What you must know:

- **What it writes to the env file.** It always writes `PADDLE_ENV` and `PADDLE_PRICES`. With `--webhook-url`, it also writes `PADDLE_NOTIFICATION_WEBHOOK_SECRET` (read from the destination, so you never copy it by hand) and `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`. In `PADDLE_PRICES`, a key maps to `{ cycle: price id }` for each cycle in the catalog. A key with only a `once` price maps to one id.
- **The destination's traffic (since v0.7.0).** Sandbox: `traffic_source: "all"`, so the webhook simulator reaches the app. **Live: `"platform"`**, real events only, so no simulated event (signed with the real secret, sent by anyone with dashboard access) can reach an app that grants real access. A re-run moves an existing destination to the right value (0.6.x made live destinations with `"all"`).
- **Markers.** The product has `custom_data.paddle_kit = "<app>"`. Each price has `custom_data.paddle_kit_price = "<key>-<cycle>"`. The destination description is `"<app> (paddle-kit)"`. The CLI finds its own resources only with these markers. It never touches other resources. On teardown, it keeps a product that has prices from other sources. A changed `amount` updates only that price.
- **Live and test never mix.** Before it sends a request, the CLI refuses: a live key without `--live`; `--live` with a sandbox key; and a live run (except `--teardown`) when the env file has a `test_` client token.
- **After `--teardown`,** `PADDLE_PRICES` in the env file still points to the archived prices. Remove it or make it again before the app reads it.
- The CLI never shows the key. It removes the key from all output and error messages.
- A top-level `"$schema"` string in the catalog JSON is allowed, and the CLI ignores it.
- **The host block (since v0.6.0).** After each run (except `--teardown`), the CLI prints the variables that the deployed app needs, from the env file: `PADDLE_ENV`, `PADDLE_PRICES`, `PADDLE_NOTIFICATION_WEBHOOK_SECRET` and `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`. Paste it into your host (sandbox: Preview and Development; `--live`: Production). The secret is a commented line unless you pass `--show-secrets`, so a pasted block never sets a placeholder as the secret: the deployed app then reports the missing variable instead. Never paste the block into a chat or a ticket with `--show-secrets`.
- With `--host vercel`, the block also has one `printf '%s' '<value>' | vercel env add <NAME> <environment>` line per variable and environment, and `vercel env add <NAME> <environment>` (it asks for the value) for the hidden secret. **UNVERIFIED:** we did not run these commands against a real Vercel project. Check that `vercel env add … preview` from a pipe does not ask for a Git branch in your Vercel CLI version.
- The CLI prints the four variables that it writes. It also lists, as a comment, the ones that it cannot know: `PADDLE_API_KEY` (only if the app uses `reconcile` or `getPrice`), `PADDLE_HEALTH_TOKEN`, `BILLING_LAUNCH_AT` and `BILLING_ENFORCE`.

## Moving an app that already has a catalog

The CLI finds resources only by its own markers. It cannot see a catalog from an older script. If you run the CLI next to that catalog, you get a **second product and a second destination**. Two destinations on one URL both send events, each signed with a different secret. One of them always fails with `signature_mismatch`.

Example (Offday): its old script used the markers `offday` / `offday_price` and the destination `Offday (sandbox)`. Before the first CLI run, do one of these:

1. Run the old script's teardown. It archives the old prices and product, and turns off the old destination.
2. Or turn off the old destination in the Paddle dashboard (Developer tools > Notifications), and archive the old catalog by hand.

Then run the CLI. Replace `PADDLE_PRICES` and `PADDLE_NOTIFICATION_WEBHOOK_SECRET` in the app with the new values. After that, make sure that exactly one active destination points to your URL.

Existing subscriptions on archived prices should continue to renew. Only new checkouts need the new price ids. **UNVERIFIED:** confirm this in sandbox before you archive a live catalog.

## Monitoring

**The health route.** Set `healthToken` to turn it on. Use `GET` on the same path, with the header `Authorization: Bearer <token>`.

- Without `healthToken`, the route answers 404. With a wrong token, it answers 401.
- If the store is down, the route answers **503 `{ "error": "store_error" }`** and writes `store_error` to the log. It does not throw.
- The token is compared in constant time after hashing both sides (since v0.7.0), so neither its content nor its length leaks through timing.
- There is no pinger. The signal comes from real webhook traffic.

**The main "alive" signal is `lastEventAt`.** If no verified event arrives for longer than your normal gap between events, find out why. Other products' events also count (see `owns`). A wrong webhook secret shows here: no event is verified, so `lastEventAt` goes old. `paddle-kit-doctor --stale-hours` (or `staleHours` in an apps file) turns that into a problem.

**Requests refused before the signature check never touch the store (since v0.7.0).** A missing or oversized body, a missing or bad signature, and a timestamp out of the window are answered 400/401/413 and counted in **the server instance's memory** (`unverified` in health), with at most one warn log line a minute (`count` = refusals since the last line). Anyone can send these requests: before v0.7.0 each one wrote a `paddle_failures` row, so a bot hitting the URL kept a serverless Postgres (Neon) awake. The count starts again when the instance restarts, and each instance has its own: on serverless hosts the instance that answers the health GET may not be the one that refused the request. Only signed requests (`bad_json`, `bad_payload`) and failed events are still written to the store.

| Field | Meaning |
|---|---|
| `lastEventAt` | When the last verified event arrived (processed, ignored or stale). `null` if there is none yet. |
| `lastFailureAt` | The time of the last failure: a failed event, or a signed request refused as `bad_json` / `bad_payload`. Since v0.7.0 not a refusal before the signature check (see `unverified`). |
| `lastFailureReason` | Our own reason code for it. Never secret text, never driver text. |
| `failedLast24h` | Failed events plus refused signed requests in the last 24 hours. |
| `unlinkedLast24h` | Subscription events with no `userId` (stored with `user_id = NULL`, reason `no_user_id`). To fix, open each checkout with `createCheckout`, which sets `customData.userId`. |
| `lastOwnedAt` | When the last event that `owns` matched arrived: a processed event with reason `null` or `no_user_id`. Events with reason `mirrored` or `unmatched`, and late (`out_of_order`) deliveries, do not count. Without `owns`, every event matches. `null` if there is none yet. Since v0.5.0. |
| `notOursLast24h` | Events acked as `not_ours` in the last 24 hours (other products on a shared seller account). Since v0.5.0. |
| `kitVersion` | The paddle-kit version that the app runs, for example `"0.5.0"`. Added by the route, not by the store. Since v0.5.0. |
| `environment` | `sandbox` or `production`, from `createBilling`. Added by the route, not by the store. Since v0.5.0. |
| `unverified` | `{ since, count, byReason, lastAt, lastReason }`: requests refused before the signature check, counted in the memory of the instance that answers, since `since` (its start). Added by the route. Since v0.7.0. |
| `checks` | `{ [name]: { ok, detail? } }`, one per `healthChecks` entry; only when you set `healthChecks`. Since v0.7.0. |

**App checks (since v0.7.0).** `createBilling({ healthChecks: { price: async () => ({ ok: true, detail: 'paddle' }) } })`. The checks run only on the authenticated health route, all at the same time, each within `healthCheckTimeoutMs` (default 3000). A check that throws, times out or returns no `{ ok }` is `{ ok: false }` with a short detail, and `onError` gets the thrown error; the error text never reaches the report. `detail` is shown as you return it: never put a secret in it. A failed check makes `paddle-kit-doctor` exit 1. Example: [Find prices by their label](payments.md#find-prices-by-their-label-no-price-id-in-the-env-since-v070), "Show where the price came from".

**Alert rule for a wrong `owns`:** `lastOwnedAt` older than N days (your longest normal gap between your own sales or renewals) **and** `notOursLast24h > 0` = your `owns` is wrong. Paddle's events still arrive, but the kit sends all of them to `not_ours`, so `lastEventAt` stays fresh and `failedLast24h` stays 0. On a shared seller account `notOursLast24h > 0` alone is normal traffic; do not alert on it.

Limits of this rule:

- It catches an `owns` that matches none of your traffic. If `owns` misses only one new price while other prices in `owns` still sell or renew, `lastOwnedAt` stays fresh, and the rule stays quiet.
- A refund of a one-time purchase that was ours before `owns` broke still counts (the kit uses the stored owned flag), so steady refunds of older purchases can delay the alert by up to your refund window plus N days.
- The trade-off: if all of an app's paying subscribers are on a retired price that is no longer in `owns`, their renewals are `mirrored`, and the rule gives a false alarm. Add the retired price to `owns` (with `products`, list it in `retiredPriceIds`: that adds it to `owns` and keeps its features).
- v0.4.0 recorded refunds of transactions it never saw, `customer.*` events and events kept only because their subscription was mirrored with reason `null`. Such rows count in `lastOwnedAt` until they are older than your N days.

**Deploy check: `paddle-kit-doctor` (since v0.6.0).** It calls the health route of a deployed app and says in plain words what is wrong:

```bash
npx paddle-kit-doctor --url https://app.example.com/api/paddle --token "$PADDLE_HEALTH_TOKEN"
```

- `--token` defaults to the `PADDLE_HEALTH_TOKEN` environment variable, so you can keep the token out of your shell history. The token is never printed.
- It shows: reachable or not, billing on or off, the environment and kit version, the env problems by name, the last event time, and the last failure reason with its meaning (for example `signature_mismatch`: the webhook secret on the host does not match the destination).
- **Exit 1 on a problem:** not reachable, a redirect (it does not follow it), a refused token, billing off, the health route off, misconfigured, `store_error`, a `signature_mismatch`, `store_error`, `hook_error` or `prices_unavailable` in the last 24 hours, a failed app check, or (with `--stale-hours <h>`) no verified event for more than `h` hours. Other failure reasons (often bots) and "no event yet" are shown, but exit 0.
- Since v0.7.0 it also shows the `unverified` refusals of the instance that answered. A `signature_mismatch` among them is a WARNING, not a problem: a bot can send one too. If Paddle sent it, no event is verified any more, and `--stale-hours` catches that.
- The problem names and `billing_off` / `health_off` need a route made with `createWebhookRoute` (v0.6.0). For the names, pass `healthToken` to it. An older route answers a plain 404 or 503, and the doctor says what that can mean.
- `https` only (http only for `localhost`), because the token is in the request. Timeout: `--timeout <ms>`, default 10000.

**Every app in one run: `paddle-kit-doctor --apps apps.json` (since v0.7.0).** For a scheduled job (the plan: a private `SnaxxTech/billing-watch` repository runs it every 6 hours from GitHub Actions and keeps one issue open per red app).

```jsonc
// apps.json: names, URLs and the NAME of each token's variable. Never a token: an entry with "token" is refused.
[
  { "name": "leakscan", "url": "https://leakscan.app/api/paddle", "tokenEnv": "LEAKSCAN_HEALTH_TOKEN", "staleHours": 48 }, // must end in _HEALTH_TOKEN (v0.9.2)
  { "name": "offday",   "url": "https://offday.app/api/paddle",   "tokenEnv": "OFFDAY_HEALTH_TOKEN",   "staleHours": 24 }
]
```

```bash
LEAKSCAN_HEALTH_TOKEN=… OFFDAY_HEALTH_TOKEN=… npx paddle-kit-doctor --apps apps.json
```

```text
APP       RESULT   REACHABLE  ENV  LAST EVENT                FAILED 24H  CHECKS
leakscan  OK       yes        ok   3 h ago                   0           price ok
offday    PROBLEM  yes        ok   3 days ago STALE (>24 h)  0           -
offday: PROBLEM: no verified event for more than 24 h: check the webhook secret and the Paddle notification destination
Result: PROBLEM in offday (exit 1)
```

- The apps are checked at the same time, each with its own timeout. An app whose token variable is not set is red without a request.
- `staleHours` (optional, per app) is the longest normal gap between verified events for that app. Unset: age is shown, not judged.
- **`--json`** prints `{ ok, checkedAt, apps: [...] }`. Each app has `name`, `url`, `tokenEnv` (the variable's name, never its value), `ok`, `reachable`, `httpStatus`, `billing` (`on`, `off`, `health_off`, `misconfigured` or `null`), `environment`, `kitVersion`, `envProblems`, `lastEventAt`, `lastEventAgeHours`, `staleHours`, `stale`, `lastOwnedAt`, `failedLast24h`, `lastFailureReason`, `lastFailureAt`, `unverifiedCount`, `checks` and `problems` (plain words; empty when `ok`). A job opens or updates one issue per app with `ok: false` and closes it when the app is `ok` again.
- **Exit codes:** 0 every app green; 1 one or more apps red; **2 the apps file or the flags are wrong, and nothing was checked**: a job must not close issues on exit 2.
- A token is never printed, in the table or the JSON. `--apps` takes no `--url`, `--token` or `--stale-hours`.

**The dashboard: `--html <file>` (since v0.7.0).** The same run also writes one status page: a summary (apps, OK, needing attention, bot requests turned away), then a card per app, red first, each with what to fix in plain words. The page is one self-contained HTML file: no script, no external file, no token, every value escaped. It follows the viewer's light or dark mode and works at phone width.

```bash
LEAKSCAN_HEALTH_TOKEN=… QRLAB_HEALTH_TOKEN=… OFFDAY_HEALTH_TOKEN=… \
  npx paddle-kit-doctor --apps apps.json --json --html site/index.html > results.json
```

Publish it from `SnaxxTech/billing-watch` every 6 hours: the tokens stay in GitHub secrets, and only the finished page goes to Vercel, behind Vercel's login (Project > Settings > Deployment Protection > Vercel Authentication, scope **All Deployments**: Standard Protection leaves production domains public). A sketch of the workflow (**UNVERIFIED**: not run yet; pin `vercel` to a version):

```yaml
# .github/workflows/billing-watch.yml
on:
  schedule: [{ cron: '17 */6 * * *' }]
  workflow_dispatch: {}
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - name: Check every app
        env:
          LEAKSCAN_HEALTH_TOKEN: ${{ secrets.LEAKSCAN_HEALTH_TOKEN }}
          QRLAB_HEALTH_TOKEN: ${{ secrets.QRLAB_HEALTH_TOKEN }}
          OFFDAY_HEALTH_TOKEN: ${{ secrets.OFFDAY_HEALTH_TOKEN }}
        run: |
          mkdir -p site
          set +e
          npx --yes --package=github:SnaxxTech/paddle-kit#v0.9.3 paddle-kit-doctor --apps apps.json --json --html site/index.html > results.json
          code=$?
          [ "$code" -eq 2 ] && exit 2   # the file or flags are wrong: fail loudly, publish nothing
          exit 0                        # red apps are shown on the page (and, later, as issues)
      - name: Publish the page
        env: { VERCEL_TOKEN: '${{ secrets.VERCEL_TOKEN }}', VERCEL_ORG_ID: '${{ secrets.VERCEL_ORG_ID }}', VERCEL_PROJECT_ID: '${{ secrets.VERCEL_PROJECT_ID }}' }
        run: npx --yes vercel deploy site --prod --token "$VERCEL_TOKEN" --yes
```

Put a `site/vercel.json` next to the page so browsers always ask for the newest copy and search engines skip it: `{ "headers": [{ "source": "/(.*)", "headers": [{ "key": "Cache-Control", "value": "public, max-age=0, must-revalidate" }, { "key": "X-Robots-Tag", "value": "noindex" }] }] }`. One static file per run costs one deployment and a few edge requests per view.

**Adding an app later** is one line in `apps.json` (`name`, `url`, `tokenEnv`, optional `staleHours`) plus its token as a GitHub secret named like `tokenEnv`. The page, the table and the JSON grow with it; nothing else changes.

**Rotate the webhook secret without downtime (since v0.7.0).** Paddle gives each destination its own secret. To change it, make a second destination for the same URL (its secret is new), and put both secrets in `PADDLE_NOTIFICATION_WEBHOOK_SECRET`, separated by a comma: `pdl_ntfset_old,pdl_ntfset_new`. Pass `webhookSecret: config.webhookSecrets ?? config.webhookSecret` (`createBilling` takes an array). Deploy. Both destinations now deliver each event, and the ledger keeps one (same `event_id`). Turn off the old destination, remove the old secret, deploy again. **UNVERIFIED** against real Paddle: that two destinations send the same `event_id`.

**Reason codes:** `missing_body`, `body_too_large`, `bad_signature_header`, `signature_mismatch`, `stale_timestamp`, `future_timestamp`, `bad_json`, `bad_payload`, `unknown_event`, `no_user_id`, `out_of_order`, `store_error`, `hook_error`, `not_ours`, `unmatched`, `mirrored`, `prices_unavailable`.

- `future_timestamp` (v0.7.0) is a 401 for a signature whose timestamp is more than `clockSkewSeconds` (default 60) ahead of the server clock: the server's clock is behind, or a request was made to be replayed later. The past side stays 5 s (`stale_timestamp`). Both are checked only after the signature matched, and both are counted in `unverified`, not in the store.
- `prices_unavailable` (v0.7.0) is a 503 when an `owns` resolver could not find the app's price ids. The event is marked `failed` and Paddle retries; it is never recorded as `not_ours`.

- `not_ours` (v0.4.0) is `ignored`. It is never a failure.
- `body_too_large` is a 413 for a body over `maxBodyBytes` (default 4 MB, `MAX_WEBHOOK_BODY_BYTES`, just under Vercel's request limit). The kit stops reading at the cap, before it checks the signature, and counts the request in `unverified` (in `failedLast24h` before v0.7.0). A Paddle event is a few KB plus about 2 KB per line item. If you lower the cap, keep it far above your largest transaction: Paddle retries a refused event and then drops it.
- `unmatched` (v0.5.0) is `processed`, but `owns` never matched it: an adjustment with `ctx.known === false` (on a shared seller account it can be another app's refund). The hook ran. It is not a failure and writes no log line. It does not count in `lastOwnedAt`.
- `mirrored` (v0.5.0) is `processed` only because its subscription is already in the mirror; `owns` did not match it. An adjustment of such a subscription is `mirrored` too. The hook ran. It is not a failure and writes no log line. It does not count in `lastOwnedAt`.
- A 409 `in_progress` answer is not a failure. It is not logged or counted. Paddle's next try becomes a 200 duplicate.
- Log lines contain only `reason`, `eventId`, `eventType` and (for the once-a-minute line about refused requests) `count`. They never contain the body, the signature header or secrets.

**`failedLast24h` is approximate.** The kit counts refused signed requests (and failures with no event row) per minute and per reason. A minute counts if its last hit is in the 24-hour window. So the number can be too high by one minute of hits at the edge of the window.

**Failures that recover disappear.** A `hook_error` or `store_error` event counts in health only while it is `failed`. When Paddle's retry works, the event becomes `processed`, and it is no longer in `lastFailureAt` or `failedLast24h`. A refused signed request (bad JSON, bad payload) gets no retry, so it stays for 24 hours. A clean health after an incident means "recovered", not "nothing happened". Look in your logs for `hook_error`.

**Retries.** Paddle sends the event again after each answer that is not 2xx:

| Account | Retries |
|---|---|
| Live | up to 60 tries in about two days (about 10 in the first hour, about 45 in the first day) |
| Sandbox | 3 tries within about two minutes |

Source: Paddle, [Respond to webhooks](https://developer.paddle.com/webhooks/respond-to-webhooks), read 2026-10-29. In sandbox a broken endpoint loses an event within minutes, so watch the first deliveries.

After the last try, Paddle drops the event. So you must see a broken endpoint during that time. After an outage, run `reconcile` from an existing cron job:

```ts
import { reconcile } from 'paddle-kit/reconcile';
await reconcile(billing, { apiKey: process.env.PADDLE_API_KEY! }); // { scanned, applied, notOurs, invalid }
```

**Payments and refunds too (`reconcilePayments`, since v0.7.0).** `reconcile` repairs subscriptions only. A lost one-time payment or refund (Paddle gave up after its retries) is repaired by:

```ts
import { reconcilePayments } from 'paddle-kit/reconcile';
await reconcilePayments(billing, { apiKey: process.env.PADDLE_API_KEY!, since: new Date(Date.now() - 7 * 86_400_000) });
// { transactions: { scanned, applied, duplicates, notOurs, failed }, adjustments: { … } }
```

- It reads completed transactions updated since `since` (`GET /transactions`, 30 a page) and the adjustments updated since then (`GET /adjustments`, 50 a page; up to 10,000).
- Each one goes through the **webhook's own ledger path** as a delivery with its own event id (`reconcile_txn_<id>`, `reconcile_adj_<id>_<status>`): `owns`, the hooks, the claims and the dedup apply as for a webhook. A second run with the same window is a no-op (`duplicates`).
- A payment the webhook already processed runs `onTransaction` once more (hooks run at least once and must be idempotent). An adjustment status that changed replays again, as the webhook would.
- Adjustments run after transactions. If the store never saw an adjustment's transaction (a payment older than `since`), that transaction is read and replayed first, so a refund is never judged without its payment. On a shared seller account, other apps' refunds come out `notOurs`, with no hook.
- `failed` counts replays whose hook or store failed: run it again later. Run it daily from a cron with a window longer than the gap between runs (for example 7 days). Edge-safe.

How `reconcile` works:

- It reads `GET /subscriptions` with `fetch`, 200 per page. It follows Paddle's pages and never goes to a different host.
- With `since` within 89 days (since v0.8.7), it reads only the `subscription.*` events since then (`GET /events`, needs `notification.read`) and applies each subscription's newest state, instead of every subscription. `recoverBilling` passes its window, so a run after a recent checkpoint reads only what changed. A first run or an older window still reads the full list.
- It uses the same `subscriptionFrom()` as the webhook path. So a reconciled row is equal to the webhook row (snake_case `raw`, the same status and `userId` checks).
- Each row has the API's `updated_at`, so a later webhook still wins.
- `invalid` counts the subscriptions that the webhook path would also refuse.
- It is safe for edge runtimes. To use your own `fetch`, pass `fetch`.

The webhook path only writes to your store. It never calls the Paddle API, because Paddle waits only 5 seconds; the one exception is an `owns` resolver (`resolvePrices`), which looks the prices up once per `cacheSeconds` per instance. The signature clock check allows 5 seconds (the `signatureToleranceSeconds` option was removed in v0.4.0).

**No inbox needed (measured for v0.8.7).** The webhook does its work before it answers, and that fits well inside Paddle's 5 seconds. `node scripts/bench-webhook.mjs` (after `npm run build`) sends `transaction.completed` for a one-time purchase through `handleWebhook` on real Postgres 17. `onTransaction` is `createFulfilment`, which grants plus `enqueue`s an outbox item in one transaction. The script checks that every sample left its fulfilment, outbox and account row. On a loaded laptop (load average 7–8), the worse of two runs gave:

| Path | Samples | p50 | p95 | max |
|---|---|---|---|---|
| Cold: fresh Node process, import + pool + first webhook | 30 | 107 ms | 165 ms | 507 ms |
| Warm, one at a time | 500 | 4.4 ms | 15 ms | 85 ms |
| Warm, 10 at once | 500 | 14 ms | 34 ms | 128 ms |

This path makes **14 SQL round trips** per webhook, and the database was on localhost. On a networked database, add 14 × the round-trip time, for example about 15–70 ms at 1–5 ms in the same region. Add the platform's cold start and a scale-to-zero database's wake-up on top. Those two are not measured here: check them in your host's function logs. Keep the database in the function's region, and put slow external work (email, other APIs) in the outbox instead of the hook. If a hook can't stay under a few seconds, `hookTimeoutMs` turns it into a retry rather than a lost event.

**Note:** a slow cold start can use up the 5 seconds. In local testing, a dev server that compiled for 4.5 s refused the first event with 401 `stale_timestamp`. Paddle sends the event again, so this costs one retry, not the event.
