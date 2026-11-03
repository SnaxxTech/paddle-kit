# QR Lab connected Neon migration receipt

Applied at: 2026-10-30T13:13:03.949093+00:00

Target: Vercel project `snaxx-tech/qr-lab`, connected Neon resource `kiwiimenu-db`.
Source: QR Lab integration worktree, local `codex/qr-lab-resilience` branch and installed `paddle-kit@0.8.0-qr.1` candidate.

Preflight: no public or Drizzle tables existed. Used the resource's direct database connection with credentials held in a mode-0600 temporary file.

Executed the existing `scripts/db-migrate.ts` with Node 24.18 and tsx. Completed:

- App `0000_init` (one migration recorded in `drizzle.__drizzle_migrations`).
- Kit `001_init`.
- Kit `002_claims_transactions`.
- Kit `003_recovery`.

Post-check: all 13 app tables and 7 kit tables exist; `paddle_recovery` and `paddle_events_unfinished_idx` are present. No application data was inserted or removed. The temporary connection file was deleted afterward.

This applies the database schema only. It does not deploy the candidate code, configure Paddle credentials/destinations, or establish hosted recovery health. Deploy the updated app and configure sandbox billing before checkout testing.
