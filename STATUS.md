# Billing status: paddle-kit and our apps

Last update: 2026-10-20. Update this file when a step is done.

## In simple words (ELI5)

We built one billing helper, **paddle-kit**, and we put it into our web apps. The helper takes payments from Paddle, remembers who paid, and tells each app "yes, this person paid" or "no".

- **Done:** the helper (v0.4.0) is finished and tested. Two apps use it: **Offday** (monthly plans) and **AppCare** (one-time "Full Scan" purchase).
- **Not live yet:** no real money moves yet. Everything ran in Paddle's **sandbox** (test mode, test cards).
- **Next:** the owner does some account steps (secrets, dashboard settings, a question to Paddle). Then we review and merge the pull requests, and test with real sandbox events again.
- **QR-Lab** has a plan only. It needs a backend first.

## Where each project is

| Project | State | Pull request | What is done | What is next |
|---|---|---|---|---|
| **paddle-kit** | **v0.5.0 in review** (public repo, CI on) | — (on `main`) | Webhook checks, one-time processing, subscription copy, `hasAccess`, trials, env checks, catalog CLI, refunds, shared-account filter (`owns`). 321 tests pass on real Postgres 17. CI is on. | Test v0.5.0 with real sandbox events. |
| **Offday** | **Ready for review** | [SnaxxTech/offday#34](https://github.com/SnaxxTech/offday/pull/34) | Monthly and yearly plans, 30-day trial, read-only mode after the trial (behind `BILLING_ENFORCE`, off by default). On kit v0.4.0 with `owns`. A real sandbox checkout and cancel worked (on v0.2). | Upgrade to v0.5.0 (no CI secret needed). Review and merge. |
| **AppCare** | **Ready for review** | [SnaxxTech/SlopRemover#7](https://github.com/SnaxxTech/SlopRemover/pull/7) | One-time Full Scan. Payment checks, refunds, chargebacks, a review queue for people, `billing:status` and `billing:reconcile`. Passed 3 review rounds. On kit v0.4.0 with an `owns` function. 222 tests pass. | Choose the host. Run migration 0005 there. Review and merge. |
| **QR-Lab** | **Plan only** | [SnaxxTech/QR-Lab#5](https://github.com/SnaxxTech/QR-Lab/pull/5) | Billing plan, price catalog file, a test that the catalog matches the pricing page. | Owner decides backend, login and database. Then we build. |

## Owner actions (only the owner can do these)

Do them in this order. Each step says how to check that it is done.

1. **Done in v0.5.0: no CI secret is needed.** The kit repository is public, so Offday and AppCare install it with no token. (Before, Offday CI was red because the secret `PADDLE_KIT_READ_TOKEN` was never saved.)
2. **Change the Paddle sandbox API key.** The old key was pasted in a chat. Make a new key in the sandbox dashboard. Put it in `paddle-kit/.env.sandbox` and `offday-billing/.env.local` (both are not in git). Then turn off the old key.
3. **Ask Paddle about Kosovo payouts** (support, or the seller verification). **Do not use live keys before you have the answer.**
4. **Set the default payment link in the live dashboard:** Paddle > Checkout > Checkout configuration. The sandbox already has one. Live is a different account.
5. **Choose the AppCare host** (for example Vercel). The host installs the public kit with no token.
6. **Choose where AppCare's `billing:status` alerts go** (email, chat or a dashboard).
7. **QR-Lab decisions:** backend, login, database (Supabase or Neon) and package manager. Its `main` branch already fails lint, type check and build.
8. **Review and merge** the three pull requests above.
9. **Done in v0.5.0:** the kit's CI is on (`.github/workflows/ci.yml`).

## Engineering next steps (anyone on the team can take these)

| # | Task | Why | Size |
|---|---|---|---|
| 1 | ~~Turn on paddle-kit CI~~ Done in v0.5.0 | Tests run on each push and pull request. | Done |
| 2 | Sandbox end-to-end test of v0.4.0 in Offday and AppCare: real checkout, real refund, a second product's sale | The v0.4.0 tests used signed test events, not events from Paddle. | Medium |
| 3 | AppCare: run its two-connection tests on a real Postgres | Locks between two connections are only tested in the kit, not in AppCare. | Small |
| 4 | AppCare: let `billing:reconcile` read refunds from Paddle | If both the payment event and the refund event are lost, reconcile pays the order. The customer then gets one free scan. | Medium |
| 5 | Offday: fix the shifts test (`tests/shifts.spec.ts:741`, expects 5 shifts, gets 4) | Not billing. It fails before and after the upgrade. It is possibly a date problem (it failed on a Saturday). | Small |
| 6 | Offday: run the catalog CLI again with the real URL | `.env.local` still has the secret of an old, turned-off destination. | Small |
| 7 | QR-Lab: build billing on kit v0.4.0 (after owner action 7) | The plan is in PR #5. | Large |
| 8 | Delete the old local branch `feat/v0.4-shared-seller` in paddle-kit | It has the history from before the CI file was removed. It is not pushed and not used. | Small |

## Not tested yet (UNVERIFIED)

- **Real Paddle events on v0.4.0.** All v0.4.0 tests used signed test events.
- **A real subscription renewal, a failed renewal (past_due), a partial refund and a chargeback** from real Paddle.
- **Two database connections at the same time in AppCare** (the kit itself passed this test on real Postgres).
- **AppCare migration 0005 on a production database.** There is no host yet.
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
| Kit code | `github.com/SnaxxTech/paddle-kit`, branch `main`, tag `v0.4.0` |
| How to add the kit to an app | [README.md](README.md), and the agent skill `skills/integrating-paddle-kit` |
| How to upgrade an app | [UPGRADING.md](UPGRADING.md) |
| Offday work | local worktree `~/Desktop/Projects/offday-billing`, branch `feat/billing` |
| AppCare work | local worktree `~/Desktop/Projects/appcare-paddle`, branch `feat/paddle-kit-hardening` |
| QR-Lab work | local clone `~/Desktop/Projects/QR-Lab`, branch `docs/paddle-billing-plan` |
| AppCare billing manual | `docs/billing.md` in the AppCare branch |

## Rules we follow

- **Sandbox first.** No live key until owner actions 3 and 4 are done.
- **Never put a secret in git, in a log or in a chat.** Env files have mode 0600 and are not in git.
- **Never drop a payment or a refund without a record.** If the code is not sure, it writes a review row for a person.
- **Run new migrations before you deploy new code.**
- **A change is done only when it is tested.** We mark each claim as tested (how) or UNVERIFIED (why).
