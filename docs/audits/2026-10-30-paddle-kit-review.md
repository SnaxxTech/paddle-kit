**Paddle Kit, billing health, and app integration review — 30 October 2026**

**Verdict:** keep the basic architecture. It has useful boundaries, a substantial test suite, and several good security decisions. It still needs corrections before these integrations should be called production ready. The important gaps are business entitlement validation, adjustment ordering, truthful health reporting, and recovery after delivery retries expire. Passing the existing tests does not cover those gaps; the additional reproductions below expose them.

This was a review and local verification. No application production code, Paddle account settings, hosted environment variables, real purchases, GitHub issues, deployments, or alerts were changed. The files added to this repository are this review and reproductions using fake data.

**Scope and version evidence**

| Component | Reviewed source | Meaning |
|---|---|---|
| Paddle Kit current checkout | `c25533c`, main, v0.6.0 | Released code in the current workspace. |
| Paddle Kit proposed release | `a2912a5`, `claude/v0-7-fixes-monitoring-5dd632`, v0.7.0 | [PR #18](https://github.com/SnaxxTech/paddle-kit/pull/18) was open and unmerged when checked. Its latest GitHub CI run was successful. |
| Offday integration | `d6a2b06`, `claude/paddle-kit-070-test-61724a` | Dedicated integration test branch. The ordinary local checkout has no Paddle Kit dependency. |
| SlopRemover / LeakScan integration | `7b22bae`, `claude/paddle-kit-070-test-50cd60` | Dedicated integration test branch. The ordinary local checkout has no Paddle Kit dependency. |
| QR Lab integration | `1f07091`, `claude/paddle-kit-070-test-a7db49` | Dedicated integration test branch. The newer ordinary QR Lab clone has account/database foundations, but no Paddle Kit dependency. Packs are explicitly deferred in the integration branch. |
| Billing health project | `billing-watch`, local main `0559598` | Scheduled doctor, issues, history, and static dashboard. Local checkout has no `apps.json` and history contains only `.gitkeep`. Remote/deployed configuration could not be verified. |

All three app test branches vendor the same v0.7.0 tarball, SHA-256 `6d6fd5e07a9d0ea867666ad57b31c416e746ebb353dbd41e80e4e029823ba265`. Billing-watch vendors a different v0.7.0 tarball, SHA-256 `cdec9102fe407cea084ca7b8f80531cc9ececedda663960a32b73b8684e0e90e`. A shared version string does not establish identical bytes. Publish and test one immutable release artifact across all four consumers before rollout.

Private app repositories and billing-watch were unavailable through the GitHub connector. Their local branches were inspected and tested; deployed versions, secrets, migrations, destination settings, and notifications remain unverified. The root `STATUS.md` is stale and should not be used as evidence that a deployment is ready.

**What is already sound**

- The framework-independent core, small Next adapter, and separate database adapters keep most provider changes inside the kit. SQL is parameterized, and migrations are additive.
- Webhooks use HMAC verification, bounded body reads, an event ledger, duplicate claims, and timestamp ordering for the subscription mirror. Server-side entitlement checks decide access; a browser checkout callback does not constitute payment proof.
- Shared-account ownership filtering is centralized. Unknown refunds reach the application instead of being silently discarded. Removing unrelated customer email storage was a good privacy correction.
- The API version is pinned. Pagination checks the origin before forwarding the API key. Default logs avoid dumping provider errors or credentials. Keys and browser tokens are checked against the configured environment.
- The hook contract correctly says **at least once**. Slopremover uses database transactions and a transaction-scoped advisory lock for payment/refund races. Its existing real-Postgres concurrency test passes.
- CI exercises types, edge compatibility, packaging, database contracts, and real Postgres. The kit has no required server runtime package dependency; browser checkout uses the Paddle.js peer.

Paddle itself requires signature validation, duplicate handling, and reasoning about `occurred_at`, because delivery can repeat and arrive out of order. The kit broadly follows those requirements. [Paddle signature verification](https://developer.paddle.com/webhooks/about/signature-verification/), [delivery guarantees](https://developer.paddle.com/webhooks/about/how-webhooks-work/).

**Findings requiring action**

**1. [P1] Slopremover can revoke access again after a dispute was won.**

[applyAdjustment](/Users/gentlegen/Desktop/SlopRemover/.claude/worktrees/paddle-kit-070-test-50cd60/src/lib/billing/fulfil.ts:258) creates an adjustment/status key, but successful revocations and restorations do not durably record that key. They update order status and append an audit action. [restoreLocked](/Users/gentlegen/Desktop/SlopRemover/.claude/worktrees/paddle-kit-070-test-50cd60/src/lib/billing/fulfil.ts:313) infers the current effect from the last audit action rather than the adjustment's identity and provider chronology.

Two additional tests fail:

- Chargeback → reversal → another delivery of that chargeback's data: expected order `paid`, actual `refunded`.
- Reversal delivered before its older chargeback: expected `paid`, actual `refunded`.

A second Paddle event ID or a reconciliation delivery can carry an adjustment already acted on, so deduplicating only webhook event IDs is insufficient. Persist adjustment identity, state, and provider time inside the same transaction as the order change. Derive the transaction's revocation state from those records, including reversals received early. A reversal must not undo a separate still-effective refund.

Evidence: [two failing desired-invariant tests](/Users/gentlegen/Desktop/paddle-kit/docs/audits/slopremover-adjustments.test.ts). These call the same fulfilment functions used by the production hooks; they use an in-memory database and fake payment data.

**2. [P1] Offday treats an add-on-only subscription as a full subscription. Seat pricing is advisory.**

[Entitlements construction](/Users/gentlegen/Desktop/Projects/offday/.claude/worktrees/paddle-kit-070-test-61724a/lib/billing.ts:29) grants `offday` for every configured price, including `extra`. [planFor](/Users/gentlegen/Desktop/Projects/offday/.claude/worktrees/paddle-kit-070-test-61724a/lib/billing.ts:53) only checks that feature flag. Team size influences the suggested checkout, but is not compared with what was purchased when access is granted or employees are added.

The actual billing module accepted a signed active subscription containing only `pri_extra_m`, quantity 1: HTTP 200, plan `paid`, and `enforcePlan(..., 'addHoliday')` allowed the write. The expected result is refusal without a base subscription. This does not require forging Paddle's signature: a buyer can alter browser checkout items before making a real payment.

Require a valid base item and validate purchased capacity against the organization's active employee count. Define how existing subscriptions change when seats cross 25, 50, and 51. Validate quantities using provider line items on the server. Keep this policy in Offday; the generic kit should not contain Offday's seat tiers.

Evidence: [Offday reproduction](/Users/gentlegen/Desktop/paddle-kit/docs/audits/offday-probes.mts).

**3. [P1] Enforced billing becomes permissive when configuration breaks.**

QR Lab's [paidTier](/Users/gentlegen/Desktop/Projects/QR-Lab/.claude/worktrees/paddle-kit-070-test-a7db49/src/lib/billing.ts:84) returns Pro when billing is null. A missing webhook secret with `BILLING_ENFORCE=1` produces configuration problems and null billing, but still returns Pro. Offday similarly returns `free` for null billing, which its write guard permits.

The permissive unconfigured experience is useful for a fresh clone or preview. Once enforcement is explicitly enabled, configuration failure should instead produce an actionable error for paid writes, while keeping reads, login, recovery, and payment management available. Preserve distinct states for intentionally off, misconfigured, unavailable, and configured. Do not erase those distinctions into `Billing | null` at the authorization decision.

The QR Lab reproduction confirms `PADDLE_NOTIFICATION_WEBHOOK_SECRET is missing` alongside tier `pro` with enforcement enabled. [QR Lab reproductions](/Users/gentlegen/Desktop/paddle-kit/docs/audits/qrlab-probes.mts).

**4. [P1] Billing health can report green while work is lost or failing.**

This affects both v0.6.0 and proposed v0.7.0. The [doctor diagnosis](/Users/gentlegen/Desktop/Projects/paddle-kit/.claude/worktrees/v0-7-fixes-monitoring-5dd632/src/doctor/cli.ts:95) considers only the latest failure reason when deciding whether failures are a problem. It does not use the unresolved failure count as an independent blocker. The store's health also omits unfinished/expired claims.

Confirmed reproductions:

| Situation | Actual diagnosis |
|---|---|
| An unresolved `hook_error`, followed by a signed `bad_json` failure | `failedLast24h: 2`, doctor `ok: true` |
| An abandoned `received` event and claim from the previous day | Zero failures, doctor `ok: true` |
| `lastOwnedAt: null`, 100 foreign events, fresh `lastEventAt`, `staleHours: 1` | Doctor `ok: true` |

The third case matters because all apps share a seller account. Other products' traffic keeps the global delivery timestamp fresh while this app's ownership configuration rejects its own payments. Doctor exposes `lastOwnedAt` in JSON but does not evaluate the ownership alert rule. [Billing-watch closes an existing issue whenever `app.ok` is true](/Users/gentlegen/Desktop/Projects/billing-watch/scripts/report.mjs:27), so these diagnoses can also suppress or close an outage alert.

Add durable unresolved failure totals independent of a 24-hour window, oldest unfinished work, expired claims, and last successful reconciliation. Evaluate owned traffic separately from general delivery traffic. Use traffic expectations for sparse/monthly billing, with an explicit initialization grace period. Per-instance unsigned-request counters in v0.7.0 are useful diagnostics but cannot establish fleet-wide delivery health.

The watcher is not established as operational by the available evidence. Its local configuration is incomplete, and [the workflow deliberately succeeds without checking anything when `apps.json` is absent](/Users/gentlegen/Desktop/Projects/billing-watch/.github/workflows/billing-watch.yml:34). Its example apps also omit stale thresholds. Add explicit bootstrap/completed setup status, configured app thresholds, a successful alert-and-recovery drill, and monitoring for the watcher itself. Deployment authentication settings remain unverified.

Evidence: [kit reproductions](/Users/gentlegen/Desktop/paddle-kit/docs/audits/paddle-kit-probes.ts).

**5. [P2] The subscription grace clock is neither atomic nor scoped to a delinquency episode.**

The [handler](/Users/gentlegen/Desktop/paddle-kit/src/core/handler.ts:91) reads the previous subscription, computes `pastDueSince`, then upserts it. Distinct event claims do not serialize updates to the same subscription. The same logic remains in v0.7.0.

- A deterministic two-event interleaving starts both reads from `active`; the newer overdue event commits first. The older event is discarded without correcting the clock. Expected start `11:00`, actual `13:00`; access remains true after the intended grace expiry.
- An older `past_due` event from before a recovery backdates a later delinquency. The reproduction delivers the old event within two days, then checks access near the later grace expiry: expected true, actual false.

Move transition/episode invariants into an atomic store operation, or serialize each subscription's updates with a transaction and lock. Preserve the recovery boundary so an older episode cannot change the current episode's start. Add both cases to the shared adapter contract and real-Postgres suite. A blanket minimum timestamp across the subscription's entire history would still be wrong.

**6. [P2] Recovery is incomplete operationally, and QR Lab reports partial recovery as success.**

[QR Lab runReconcile](/Users/gentlegen/Desktop/Projects/QR-Lab/.claude/worktrees/paddle-kit-070-test-a7db49/src/lib/billing.ts:168) returns `status: 'done'` without checking `payments.transactions.failed` or `payments.adjustments.failed`. An injected fulfilment failure returned `done` with one failed transaction replay. Its cron therefore returns 200, and its CLI exits 0. Inspect those counts and return failure or an explicit partial outcome. Track a successful checkpoint and retain failed entities for retry/backfill.

Offday's reviewed integration has no scheduled reconciliation. Slopremover has a reconciliation CLI, but its scheduled cron processes scan jobs and housekeeping, not billing reconciliation. Billing-watch calls the generic health route and does not run Slopremover's richer `billing:status`, so pending payment reviews and missing payments are not covered by that watcher alone.

Schedule bounded recovery through an existing app cron/job facility and surface its result in health. A rolling seven-day scan is a useful overlap, but an outage longer than the window needs a retained checkpoint or an explicit backfill command.

Paddle currently documents about three delivery attempts within two minutes for sandbox and up to 60 over about two days for live. Provider retries are finite. [Paddle delivery and retries](https://developer.paddle.com/webhooks/about/respond-to-webhooks/).

**7. [P2] All three integration wrappers discard additional rotation secrets.**

v0.7.0 supports multiple webhook secrets and parses comma-separated secrets into `config.webhookSecrets`. The apps pass only the singular first value: [QR Lab](/Users/gentlegen/Desktop/Projects/QR-Lab/.claude/worktrees/paddle-kit-070-test-a7db49/src/lib/billing.ts:28), [Slopremover](/Users/gentlegen/Desktop/SlopRemover/.claude/worktrees/paddle-kit-070-test-50cd60/src/lib/billing/index.ts:48), and [Offday's config wrapper](/Users/gentlegen/Desktop/Projects/offday/.claude/worktrees/paddle-kit-070-test-61724a/lib/billing-config.ts:37).

QR Lab configured with `audit_old,audit_new` reports no configuration problem but rejects an event signed by `audit_new` with 401 `signature_mismatch`. Pass the array through, or adopt `billingFromEnv` where its contract fits the app. Add an integration test accepting both secrets and deduplicating one event delivered by both destinations.

**8. [P2] API recovery needs bounded execution and an explicit incomplete result.**

The shared [Paddle REST client](/Users/gentlegen/Desktop/paddle-kit/src/core/paddle-api.ts:35) supports a signal, but reconciliation does not supply one. It has no bounded retry policy for rate limits or transient GET failures. [list](/Users/gentlegen/Desktop/paddle-kit/src/core/paddle-api.ts:59) returns its accumulated array when `maxPages` is reached even when `has_more` is still true. The reproduction returns two pages as success while a third page is advertised.

Use finite request and whole-job budgets, retry safe GETs for transient network/429/5xx responses with capped backoff and jitter, and respect retry metadata. Expose an incomplete/pagination-limit outcome or cursor; never silently claim a full repair. Consider streaming pages instead of accumulating all entities. Do not blindly retry catalog mutations without an idempotency/re-read strategy.

**9. [P2] Required billing cycles do not guarantee the shape that subscription apps assume.**

`readBillingEnv({ PADDLE_PRICES: '{"team25":"pri_audit"}', ... }, { requiredPrices:['team25'], requiredCycles:['monthly','yearly'] })` returns a valid configuration with no problems. This is documented kit behavior: cycle checks apply only to nested entries. Offday's wrapper nevertheless claims this guarantees all required values are cycle maps and casts them accordingly. QR Lab also casts entries to cycle maps.

Validate the expected shape at the app boundary, or add an explicit subscription-price schema option to the kit. Keep flat one-time prices supported. A cast should not substitute for the runtime invariant that checkout and entitlements depend on.

**Security changes already prepared in v0.7.0**

These are improvements in PR #18, rather than newly discovered unfixed defects:

| v0.6.0 behavior | v0.7.0 change |
|---|---|
| Catalog destinations use `traffic_source: 'all'` in live as well as sandbox | Live destinations use `platform`; existing destinations are patched on catalog sync. |
| Unsigned/forged requests write failure rows, allowing public traffic to wake the database | Unverified refusals remain in memory with rate-limited logging and zero store calls. |
| Arbitrarily future signed timestamps are accepted | Future-skew limit added. |
| One secret, limited error diagnostics, subscription-only reconciliation | Secret arrays, error callbacks, app health checks, and payment/adjustment reconciliation added. |

The live destination change is important: Paddle defines `platform` as real events and `all` as real plus simulation events. [Paddle notification-setting reference](https://developer.paddle.com/api-reference/notification-settings/create-notification-setting/). Merging code alone does not reconfigure an existing hosted destination; verify the resulting setting when the appropriate catalog sync is run.

An npm advisory query against the locked kit dependencies returned **zero known vulnerabilities** on this review. This is evidence about published dependency advisories, not a guarantee of application security.

**Verification actually performed**

| Check | Result |
|---|---|
| Kit v0.6.0 ordinary suite | 354 passed |
| Kit v0.6.0 typecheck, build, edge check | Passed; 13 edge files, zero violations |
| Kit v0.7.0 ordinary suite | 436 passed |
| Kit v0.7.0 real Postgres 17.10 suite | 5 passed; 50 concurrent duplicates ran one hook; 1,000-event load, zero errors |
| Kit v0.7.0 typecheck, build, edge check | Passed; 14 edge files, zero violations |
| Kit v0.7.0 packaged-consumer smoke | Passed: imports, NodeNext types, both CLIs, signed webhook behavior |
| QR Lab complete suite | 203 passed |
| Offday billing Playwright/API suite | 37 passed; local app and fake email server |
| Offday TypeScript check | Passed |
| Slopremover selected billing suites | 100 passed, one real-Postgres-only case skipped in PGlite |
| Slopremover billing integration suite on real Postgres | 48 passed, including the previously skipped two-connection case; overlaps the selected suites above |
| Slopremover additional adjustment invariants | 2 failed as described in finding 1 |
| Billing-watch report tests | 4 passed |
| Additional kit/app probes | Confirmed findings 2–9 as detailed above; scheduling gaps are from source inspection |

All app tests ran in temporary copies of the reviewed branches, without copied environment files. Node 24.18 was used for kit/QR Lab/Slopremover and Node 22.23 for Offday's existing native SQLite binary. The host's default Node 23 is outside the kit's current test-tool engine ranges. A global `legacy-peer-deps=true` setting omitted Vite during installation; temporary test copies used the already installed compatible kit dependencies to supply the missing test peer. Standard CI uses its own install configuration. Postgres shared memory and Offday HTTP listeners required execution outside the filesystem/network sandbox. Initial environment-related failures were resolved before the passing results above.

**How to test the integrations before rollout**

Use the integration branches and one exact kit artifact. The ordinary app checkouts listed above currently do not exercise these integrations. Run in disposable copies and keep test databases separate from hosted data.

| Project | Local checks | Business invariant to add |
|---|---|---|
| Kit | `npm run typecheck`, `npm test`, `npm run build`, `npm run check:edge`, `npm run smoke`; require real PG in CI | Grace episode and concurrent transition cases; stalled claims; truthful diagnosis; bounded/incomplete recovery |
| QR Lab | `npm test`; `npm run typecheck` and production build in normal app CI | Every tier/cycle, expired/grace/downgrade limits, cross-workspace isolation, enforcement under misconfiguration, partial reconcile failure, both rotation secrets. Packs remain outside current scope. |
| Slopremover | `npm test -- src/lib/billing`; run billing integration with `PADDLE_IT_DATABASE_URL` pointing only at a dedicated test Postgres | One grant per transaction; atomic rollback; payment/refund race; reversal before revoke; old revoke after restore; unknown/partial adjustments enter review; review backlog reaches health |
| Offday | `npx playwright test tests/billing.spec.ts` | Add-on without base rejected; underpaid capacity rejected; 25→26 and 50→51 growth; seat decrease policy; cancellation/payment-management route; outage reconciliation |
| Billing-watch | `npm test`; doctor against controlled local routes with fake tokens | Red→one issue, unchanged red→update without notification, green→close; malformed config fails; missing setup visible; watcher failure/staleness detected |

Reproductions retained here:

- Run kit probes from this repository: `node --import tsx docs/audits/paddle-kit-probes.ts`. These emit observed failures; they are diagnostic reproductions, not a passing acceptance suite. They work with both reviewed kit versions.
- Copy `qrlab-probes.mts` into the root of a disposable QR Lab integration copy and run `node --import ./tests/_hooks.mjs qrlab-probes.mts`.
- Copy `offday-probes.mts` into a disposable Offday integration root and run `node --import tsx offday-probes.mts` using its compatible Node/native SQLite installation. It creates and removes a separate temporary database.
- Copy `slopremover-adjustments.test.ts` to `src/lib/billing/audit-invariants.test.ts` in a disposable Slopremover integration copy, then run `npx vitest run src/lib/billing/audit-invariants.test.ts`. Both tests are expected to fail until finding 1 is fixed.

After the local corrections, perform a real **sandbox** lifecycle per app:

1. Create/use each app's own sandbox notification destination and sandbox credentials. Route the exact public HTTPS webhook path: QR Lab and Offday `/api/paddle`; Slopremover `/api/paddle/webhook`. Confirm the dashboard's default payment link and the deployed environment variables. Sandbox simulation destinations may use `all`.
2. Use the browser checkout with a sandbox test card. Confirm the provider transaction, verified ledger row, correct organization/workspace link, and the server's business entitlement. Reload independently of the checkout callback. A foreign app's purchase must grant nothing.
3. Replay deliveries and send concurrent duplicates. Verify one domain grant even across different event IDs for the same transaction. Inject a failure between the order/entitlement writes and prove rollback and recovery.
4. Exercise cancellation at period end and immediately, failed renewal, recovery, grace expiry, full/partial refund, chargeback, and reversal. Permute the order of payment/refund/reversal deliveries; inspect business state, not only HTTP 200.
5. Drop payment/refund/subscription deliveries, let provider retries expire, then run recovery twice. Check the first result repairs state, the second changes nothing, and any failed entity keeps the job/health red. Include a backfill beyond the usual seven-day overlap.
6. Rotate secrets while both destinations deliver. Run the deployed doctor, then deliberately break a sandbox secret/configuration and prove the central watcher alerts and later clears. Check its page/history time and deployment authentication.

None of those real provider/host lifecycle checks was performed in this review. Local signed fixtures and fake API responses cannot establish live destination correctness, production migrations, renewal behavior, or alert delivery.

**A maintainable design for the next iteration**

Keep one billing module per app. Let the kit own provider verification, normalized events, delivery claims, mirror updates, API transport, recovery mechanics, and generic diagnostics. Let the app own organization membership, seats/tiers/orders, fulfilment, refund policy, and the server authorization decision. Let billing-watch consume a versioned health report and own notification delivery/history. Those boundaries allow provider fixes to ship centrally while business changes stay in the relevant app.

Use database transactions and durable idempotency for domain writes. Use an app outbox/job record when a payment triggers external I/O or a long scan; commit the grant and job together. Keep webhook work short. Paddle expects HTTP 200 within five seconds and recommends asynchronous handling for slow work. A durable inbox/worker is justified when processing regularly exceeds that budget; a separate service is unnecessary for short local database updates. [Paddle webhook handling](https://developer.paddle.com/webhooks/about/respond-to-webhooks/).

Prefer explicit, discriminated configuration and recovery outcomes. Add runtime validation where the app assumes a particular price shape. Preserve the existing shared Store contract tests, and add assertions for business invariants rather than duplicating implementation details. Preserve old price IDs as entitlement aliases when replacing prices, and test migrations with existing subscriptions before changing a price map.

A price amount change on an existing Paddle price can remain a catalog/data operation. A new price ID requires ownership plus entitlement mapping and historical compatibility. A business-rule change should normally touch one app's policy and its tests. A provider/protocol fix should normally touch the kit and the consumer contract matrix. An alert-policy change should normally touch doctor/health and billing-watch.

Suggested delivery order: first finish the v0.7.0 security fixes and the confirmed entitlement/adjustment/grace defects; then make enforced configuration and health/recovery outcomes truthful; wire scheduled recovery and monitoring; publish one immutable artifact; finally complete the sandbox lifecycle matrix and promote one app at a time. This keeps changes reviewable and avoids a broad architecture rewrite.
