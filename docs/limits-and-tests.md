# Limits and tests

Reference moved out of the [README](../README.md). The short status is in the README's [Status](../README.md#status).

## Known limitations

- **Grace depends on seeing recovery transitions.** Built-in stores now apply the grace transition atomically and ignore stale overdue events. If an entire recovery transition was never observed before another delinquency, a current snapshot alone cannot reconstruct the intervening episode. Review provider history when that happens. Custom stores without `applySubscription` also need their own atomic transition implementation.
  A current snapshot repairs the current status, but cannot prove the history of missed episodes. Inspect provider history before correcting that clock manually.
- **Health does not count stored failures per reason.** `failedLast24h` is one total, and health shows only the last reason. (`unverified.byReason` does count refusals per reason, per instance.)
- **`unverified` is per instance and resets on restart.** On a serverless host, health may be answered by an instance that saw none of the refused requests. Judge a wrong secret by `lastEventAt`, not by `unverified`.

## What we tested, and what we did not

**Tested:**

| Date | Version | What we did | Result |
|---|---|---|---|
| 2026-10-16 | v0.1 | Real Paddle simulator events, through a tunnel, into the kit on Postgres (PGlite) | A subscription gave access. `past_due` kept access and started the grace clock. `canceled` removed access. A wrong secret gave 401 and `signature_mismatch` in health. `reconcile` worked against the real sandbox API. |
| 2026-10-16 | v0.2 | Offday: a real sandbox subscription checkout with the test card | Access turned on. An immediate cancel turned it off. |
| 2026-10-16 | v0.3 | A real one-time checkout ($5 + VAT) | `onTransaction` ran one time, on `transaction.completed`, with `subscriptionId: null`, the checkout's `customData`, `items`, `subtotal` 500 and `total` 590. |
| 2026-10-16 | v0.3 | A real full refund through the API | `onAdjustment` ran two times: `adjustment.created` (`pending_approval`, `type: full`), then about 7 minutes later `adjustment.updated` (`approved`, `type: full`). |
| 2026-10-16 | v0.3 | Catalog CLI on the real sandbox | It made a catalog, did nothing on a second run, and its teardown removed only its own resources. It also moved Offday's old catalog. |
| 2026-10-17 | v0.4 | Test suite on a real Postgres 17.10 server (`embedded-postgres`) | 305 of 305 tests pass. 50 parallel copies of one event run the hook one time. A load of 1,000 events gave 0 errors. |
| 2026-10-29 | v0.7 | Test suite, plus the real-Postgres suite on Postgres 17.10 (`embedded-postgres`) | 436 of 436 tests, and 5 of 5 on real Postgres (1,000 events: 0 errors, 1,000 of 1,000 samples counted). 500 unsigned and forged POSTs made 0 store calls (v0.6.0 made one `recordFailure` per request). |
| 2026-10-29 | v0.7 | The packed tarball in a scratch app (`npm run smoke`), and the built `paddle-kit-doctor --apps` against two local health routes (real `fetch`, a real apps file) | Smoke passed. The doctor printed the table and the JSON, exited 1 for the misconfigured app and 0 for the healthy one in single-app mode, and printed no token. |
| 2026-11-12 | v0.9.3 | Sandbox checkout-edit test: a transaction created on the server (status `draft`, and again `ready` with a customer), opened with `Paddle.Checkout.open({ transactionId })`, then changed from the browser with `Paddle.Checkout.updateCheckout()`. Record: [docs/audits/2026-11-12-checkout-edit-probe.md](audits/2026-11-12-checkout-edit-probe.md) | The browser changed `custom_data` (including `userId`) and the items of the server-created transaction, in status `draft` and `ready`. Paddle's API then returned the changed transaction. |

Test fixtures are the real payloads that we captured (see `tests/fixtures/SOURCES.md`).

**Not tested (UNVERIFIED):**

- A real renewal, and whether `current_billing_period` moves forward when a renewal fails. The simulator's demo subscription has a fixed period.
- A partial refund and a chargeback from real Paddle.
- Subscriptions that renew on archived prices.
- v0.4.0 with real sandbox events. The v0.4.0 tests used signed test events, not events from Paddle.
- v0.7.0 against real Paddle: the live destination's move to `traffic_source: platform`, `findPrice` / `resolvePrices` against the real price list, and two destinations sending the same `event_id` during a secret rotation. All used a fake Paddle API.
- `unverified` on a real serverless host (how often the health GET reaches the instance that refused a request).
- A deploy to a real edge host. `npm run check:edge` checks API use only, not the problems of each host.
- The Neon HTTP driver.

## Kosovo payout note

**UNVERIFIED:** can Paddle pay out to a seller in Kosovo? Paddle's sanctions page does not list Kosovo as excluded, and payouts can be in EUR. But no official statement says that Paddle pays a Kosovo seller. Ask Paddle (support, or a completed seller verification) before you use live keys. Work in sandbox is not affected.

## Scripts

| Command | What it does |
|---|---|
| `npm test` | All tests. |
| `npm run test:pg` | Only the real-Postgres tests (parallel events and load). Without a Postgres server, it shows a loud SKIP line and passes. It uses `embedded-postgres`, or `pg` with `PADDLE_KIT_PG_URL`. |
| `npm run typecheck` | TypeScript check. |
| `npm run build` | Builds `dist/`. |
| `npm run check:edge` | Checks that the edge-safe bundles use no Node-only APIs. |
| `npm run smoke` | Packs the package, installs it in a temporary folder, imports each subpath and sends signed test events (`owns` filter, known and unknown refund, a forged POST counted in memory and shown in health with an app check). |
| `bash scripts/release.sh X.Y.Z` | Runs all checks, builds `dist/` into a release commit and tags it. Pushing the tag is a separate step. |

**CI is on** (since v0.5.0): `.github/workflows/ci.yml` runs the type check, the tests, the build, the edge check, the packed-tarball smoke check and the real-Postgres suite on each push and pull request.
