# Billing status: paddle-kit and our apps

Last update: 2026-10-29 (paddle-kit v0.7.0 in review). Update this file when a step is done.

## In simple words (ELI5)

We built one billing helper, **paddle-kit**, and we put it into our web apps. The helper takes payments from Paddle, remembers who paid, and tells each app "yes, this person paid" or "no".

- **Done:** v0.6.0 is released (2026-10-29). Three apps use the kit: **LeakScan** (one-time "Full Scan", $15), **Offday** (monthly and yearly plans) and **QR Lab** (plans, in its billing pull request).
- **In review:** v0.7.0 fixes the three items of the 2026-10-29 review (live webhooks take real events only; bots no longer write to the database; the retry table), lets an app find its prices in Paddle by name, and adds one command that checks every app.
- **Next:** a small private repository, `SnaxxTech/billing-watch`, runs that command every 6 hours and opens one GitHub issue per app that is red, so nobody has to check billing by hand.
- **Not live yet:** as far as this file knows, no real money moves yet (sandbox only). Check owner actions 3 and 4 first.

## Where each project is

| Project | State | Kit | Database | What is next |
|---|---|---|---|---|
| **paddle-kit** | v0.6.0 released (tag `v0.6.0`); **v0.7.0 in review** | — | — | Review and merge v0.7.0, tag it, then move the apps (UPGRADING, 0.6.x → 0.7.0). |
| **LeakScan** (was called AppCare here; repo `SnaxxTech/SlopRemover`) | On `main` | v0.6.0 | Postgres on Neon (drizzle + postgres-js) | 0.7.0: run the catalog CLI with `--live` once (live destination → `platform`), add `onError` and a price-source health check, then prices by label: `resolvePrices`, with `leakScanOwns` returned from an `owns` resolver. |
| **Offday** | Billing on kit v0.5.0 (PR state not re-checked on 2026-10-29) | v0.5.0 | SQLite | Upgrade to 0.7.0 (no migration since 0.4.0). |
| **QR Lab** | Billing pull request open, stacked on `SnaxxTech/QR-Lab#15` | v0.6.0 | Postgres on Neon (postgres-js) | Merge; then 0.7.0. See the postgres-js jsonb note in the session notes before production. |
| **billing-watch** | Not started | — | — | New private repo: `paddle-kit-doctor --apps apps.json --json` every 6 hours from GitHub Actions; one issue per red app, closed when green. |

## Owner actions (only the owner can do these)

Do them in this order. Each step says how to check that it is done. Steps 2–7 were not re-checked on 2026-10-29.

1. **Done in v0.5.0: no CI secret is needed.** The kit repository is public, so Offday and AppCare install it with no token. (Before, Offday CI was red because the secret `PADDLE_KIT_READ_TOKEN` was never saved.)
2. **Change the Paddle sandbox API key.** The old key was pasted in a chat. Make a new key in the sandbox dashboard. Put it in `paddle-kit/.env.sandbox` and `offday-billing/.env.local` (both are not in git). Then turn off the old key.
3. **Ask Paddle about Kosovo payouts** (support, or the seller verification). **Do not use live keys before you have the answer.**
4. **Set the default payment link in the live dashboard:** Paddle > Checkout > Checkout configuration. The sandbox already has one. Live is a different account.
5. **Choose the LeakScan host** (for example Vercel). The host installs the public kit with no token.
6. **Choose where billing alerts go.** Proposed: GitHub issues opened by `billing-watch` (one per red app).
7. **QR-Lab decisions:** the database is decided (Postgres on Neon, through postgres-js); its billing pull request is on kit v0.6.0.
8. **Review and merge** the open billing pull requests (QR Lab, and the kit's v0.7.0).
9. **Done in v0.5.0:** the kit's CI is on (`.github/workflows/ci.yml`).
10. **Live destinations (v0.7.0):** after the upgrade, run `paddle-kit-catalog --live` once per live app (or set *Platform* traffic in the live dashboard), so live apps take no simulated events.

## Engineering next steps (anyone on the team can take these)

| # | Task | Why | Size |
|---|---|---|---|
| 1 | ~~Turn on paddle-kit CI~~ Done in v0.5.0 | Tests run on each push and pull request. | Done |
| 2 | Sandbox end-to-end test of v0.4.0 in Offday and AppCare: real checkout, real refund, a second product's sale | The v0.4.0 tests used signed test events, not events from Paddle. | Medium |
| 3 | LeakScan: run its two-connection tests on a real Postgres | Locks between two connections are only tested in the kit, not in LeakScan. | Small |
| 4 | LeakScan: let `billing:reconcile` read refunds from Paddle | If both the payment event and the refund event are lost, reconcile pays the order. The customer then gets one free scan. | Medium |
| 9 | Build `SnaxxTech/billing-watch` on kit v0.7.0 | The owner never has to check billing by hand. | Small |
| 10 | Kit README: postgres-js stores jsonb double-encoded unless its json serializers are pass-through (QR Lab finding, 2026-10-29) | `hasAccess` throws on such rows. LeakScan is safe through drizzle. | Small |
| 5 | Offday: fix the shifts test (`tests/shifts.spec.ts:741`, expects 5 shifts, gets 4) | Not billing. It fails before and after the upgrade. It is possibly a date problem (it failed on a Saturday). | Small |
| 6 | Offday: run the catalog CLI again with the real URL | `.env.local` still has the secret of an old, turned-off destination. | Small |
| 7 | ~~QR-Lab: build billing~~ In its billing PR, on kit v0.6.0 | | Done (in review) |
| 8 | Delete the old local branch `feat/v0.4-shared-seller` in paddle-kit | It has the history from before the CI file was removed. It is not pushed and not used. | Small |

## Not tested yet (UNVERIFIED)

- **Real Paddle events on v0.4.0.** All v0.4.0 tests used signed test events.
- **A real subscription renewal, a failed renewal (past_due), a partial refund and a chargeback** from real Paddle.
- **Two database connections at the same time in LeakScan** (the kit itself passed this test on real Postgres).
- **v0.7.0 against real Paddle:** the live `traffic_source: platform` move, prices found by label, and two destinations sending the same `event_id` during a secret rotation were tested with a fake Paddle API only.
- **Kosovo payouts.**
- **Live mode.** Nothing ran with live keys.

## What v0.4.0 fixed (for the team)

| Problem in v0.3.1 | Fix in v0.4.0 | Proof |
|---|---|---|
| All apps share one Paddle account, so each app got other apps' sales. Each app had its own hand-made filter. A review found that one version of AppCare's filter dropped real refunds. | The kit filters with `owns`. Other apps' events become `ignored` / `not_ours`. | Tests in the kit, Offday and AppCare. A local drill against the Offday dev server. |
| A refund that came before its payment could be dropped. | The kit gives it to the app with `known: false`, and the app records it. | AppCare tests: refund first, then payment, means the order is **not** paid and an alert goes up. |
| 50 copies of one event at the same time ran the purchase hook up to 50 times (42 times on real Postgres). | Each event has a claim. The other copies get 409 and Paddle sends them again later. | Real Postgres 17 test: the hook runs one time. A load of 1,000 events: 0 errors. |
| `reconcile` saved rows in a different shape than the webhook. | `reconcile` uses the same code as the webhook. | A test shows that the two rows are equal. |
| Code that no app used (Express, Hono, Paddle Node SDK). | Removed. [UPGRADING.md](UPGRADING.md) lists each replacement. | Grep of both apps before removal. |

## Where things are

| What | Where |
|---|---|
| Kit code | `github.com/SnaxxTech/paddle-kit`, branch `main`, latest tag `v0.6.0` |
| How to add the kit to an app | [README.md](README.md), and the agent skill `skills/integrating-paddle-kit` |
| How to upgrade an app | [UPGRADING.md](UPGRADING.md) |
| Offday work | local worktree `~/Desktop/Projects/offday-billing`, branch `feat/billing` |
| LeakScan code | repo `SnaxxTech/SlopRemover` (package name `leakscan`) |
| QR-Lab work | local clone `~/Desktop/Projects/QR-Lab`, branch `docs/paddle-billing-plan` |
| LeakScan billing manual | `docs/billing.md` in the LeakScan repo (not re-checked on 2026-10-29) |

## Rules we follow

- **Sandbox first.** No live key until owner actions 3 and 4 are done.
- **Never put a secret in git, in a log or in a chat.** Env files have mode 0600 and are not in git.
- **Never drop a payment or a refund without a record.** If the code is not sure, it writes a review row for a person.
- **Run new migrations before you deploy new code.**
- **A change is done only when it is tested.** We mark each claim as tested (how) or UNVERIFIED (why).
