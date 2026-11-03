# QR Lab Vercel sandbox credential setup

Target: https://qr-lab-wheat.vercel.app. Vercel project: `snaxx-tech/qr-lab`.
Candidate commit: `ee83944b0f90b66d20156dcc18594aa858b419a9` on `codex/qr-lab-resilience`, containing `paddle-kit@0.8.0-qr.1` and patched Next 16.4.3. The candidate includes current `main`; `main` itself was not changed. A later deployment from `main` can replace the candidate, so retain the candidate branch until it is integrated.

Neon is already connected and migrated. Keep the integration-managed `DATABASE_URL`; do not replace it with a local database. At deployment preparation, the project's environment variable list contained Neon variables but no Paddle, Resend, cron or health variables.

## Generate the Paddle values

1. Open the Paddle **sandbox** dashboard, then Developer tools / Authentication. Create a sandbox API key starting `pdl_sdbx_`. Catalog setup needs product.read/write, price.read/write, notification_setting.read/write, and client_token.write. Runtime needs price.read, notification.read, subscription.read, transaction.read, adjustment.read and customer_portal_session.write. Use an appropriately scoped runtime key after catalog administration when practical.
2. In the QR Lab integration worktree, create a gitignored `.env.vercel-test` containing only `PADDLE_API_KEY=<your sandbox key>` initially. Keep secrets out of chat. Use Node 24.
3. Run:

```sh
cd /Users/gentlegen/Desktop/Projects/QR-Lab/.claude/worktrees/paddle-kit-070-test-a7db49
npm run billing:sandbox -- --env-file .env.vercel-test --webhook-url https://qr-lab-wheat.vercel.app/api/paddle
```

The command creates/updates QR Lab's sandbox catalog, destination and client token. It writes the exact environment values into `.env.vercel-test`; the printed webhook secret is masked, so copy its complete value from the file rather than the terminal's masked block.

4. In Paddle sandbox, Checkout → Checkout configuration → Default payment link:

```
https://qr-lab-wheat.vercel.app/dashboard/settings
```

The destination must be active at `https://qr-lab-wheat.vercel.app/api/paddle`. Do not use an old tunnel URL or the audit's archived isolated catalog.

## Fill Vercel Production variables

Open https://vercel.com/snaxx-tech/qr-lab/settings/environment-variables. Select **Production** for the following. Vercel's Production environment still uses Paddle **sandbox** for this test.

| Name | Value/source |
|---|---|
| `NEXT_PUBLIC_SITE_URL` | `https://qr-lab-wheat.vercel.app` |
| `TRUST_PROXY` | `true` |
| `PADDLE_ENV` | `sandbox` |
| `PADDLE_API_KEY` | Sandbox key with runtime permissions above |
| `PADDLE_NOTIFICATION_WEBHOOK_SECRET` | Complete generated value in `.env.vercel-test` |
| `PADDLE_PRICES` | Complete generated JSON in `.env.vercel-test` |
| `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` | Generated `test_...` token in `.env.vercel-test` |
| `PADDLE_HEALTH_TOKEN` | New random value: `openssl rand -hex 32` |
| `CRON_SECRET` | Different new random value: run the same command again |
| `BILLING_ENFORCE` | `1`, when all Paddle configuration is filled |
| `RESEND_API_KEY` | Resend API key for signup/password-reset emails |
| `EMAIL_FROM` | e.g. `KiwiiMenu <hello@your-verified-domain.com>`; domain must be verified in Resend |

Do not add `PGLITE_DATA_DIR`, do not set `COOKIE_SECURE=false`, and do not use Neon Auth variables for QR Lab's own authentication. Existing integration-managed variables can remain.

Redeploy the **candidate deployment** after filling the values; do not redeploy the older main commit accidentally. Environment changes only affect a new build.

## Verify after configuration

Put the same `CRON_SECRET` and `PADDLE_HEALTH_TOKEN` into local `.env.vercel-test`, then invoke recovery:

```sh
node --env-file=.env.vercel-test --input-type=module -e '
const r = await fetch("https://qr-lab-wheat.vercel.app/api/cron/reconcile", {
  headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }
});
console.log(r.status, await r.text());
'
```

Expect HTTP 200 and `status: done`. Then:

```sh
node --env-file=.env.vercel-test node_modules/paddle-kit/dist/doctor/cli.js --url https://qr-lab-wheat.vercel.app/api/paddle
```

Expect sandbox, kit version `0.8.0-qr.1`, and successful recovery/price checks. Until credentials are configured, `GET /api/paddle` returning HTTP 404 with `billing_off` is expected; it is not proof that billing is operational. The cron refuses requests without its bearer secret.

Sign up using email, choose Pro monthly in Settings, use test card 4242 4242 4242 4242 with a future expiry and CVC 100, reload and verify Pro. Cancel immediately in Paddle sandbox and verify Free. Repeat with the QR Lab destination temporarily deactivated to test missed-event recovery, then reactivate it. The daily Vercel cron is configured for 04:17 UTC; verify actual runs and alerts separately.

## Deployment receipt

Completed 30 October 2026. Pushed candidate commit `ee83944` to the existing GitHub repository; Vercel's preview build completed successfully. Promoted that preview through Vercel, which rebuilt it with Production environment variables. Production deployment: https://vercel.com/snaxx-tech/qr-lab/Bix9eViYoEyL4mxN19C8u4iUTgyL. Vercel reports Ready and assigns https://qr-lab-wheat.vercel.app.

Public smoke checks after promotion:

- `/`: HTTP 200.
- `/pricing`: HTTP 200.
- `/sign-in`: HTTP 200.
- `/api/paddle`: HTTP 404, JSON `{"error":"billing_off"}`; expected until Paddle variables are supplied.
- `/api/cron/reconcile`: HTTP 401 without authorization; expected.

The build's warnings concern the existing broad Node engine range (future automatic major upgrades), a platform npm cache setting and install-script allowlisting. No build failure occurred. Pinning the deployment Node major can be considered separately; no unrelated runtime setting was changed in this deployment.

Paddle and email credentials were not added or changed. Hosted checkout, authenticated recovery, webhook delivery and signup emails remain unverified until those settings are filled. Screenshot: [production deployment](qr-lab-evidence/qr-vercel-deployed.jpg).
