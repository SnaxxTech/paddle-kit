# Version notes (simple words)

Older setup notes moved out of the README. The current setup is the README's Quickstart; every change is in [CHANGELOG.md](../CHANGELOG.md).

## What v0.7.0 changed (simple words)

1. **Bots cannot keep the database awake.** A request without a valid Paddle signature is answered and counted in memory only. Before, each one wrote a row, so a bot on the URL kept a serverless Postgres (Neon) running.
2. **Live apps get real events only.** The catalog CLI sets a live destination to `traffic_source: platform`. Simulated events reach sandbox apps only.
3. **Prices by name.** An app can find its prices in Paddle by the catalog label (`findPrice`, `resolvePrices`), so its env needs no price ids. If Paddle cannot answer, the webhook asks Paddle to retry (503); it never throws an event away.
4. **One command checks every app.** `paddle-kit-doctor --apps apps.json --json` gives one result per app, for a job that opens an issue when an app turns red.
5. **Your own checks in health** (`healthChecks`), the cause of a failure for your error tracker (`onError`), time limits for hooks and the store, and several webhook secrets at once for a rotation.

## What v0.4.0 changed (simple words)

1. **Apps share one seller account safely.** Each app tells the kit which prices are its own (`owns`). The kit ignores other apps' events. It records them as `not_ours`, and they are not errors.
2. **A refund is never lost.** A refund can arrive before its payment. The kit gives that refund to your app with `known: false`, so that your app can keep a record of it.
3. **No double processing.** Before v0.4.0, 50 copies of one event sent at the same time ran your hook up to 50 times. Now the hook runs one time. The other copies get HTTP 409 `in_progress`, and Paddle sends them again later. This was tested on a real Postgres 17 server.
4. **Less code.** We removed the parts that no app used: the Express and Hono adapters, the Paddle Node SDK and some exports. [UPGRADING.md](../UPGRADING.md) gives the replacement for each.
5. **One new migration:** `002_claims_transactions`. Run it **before** you deploy v0.4.0.
