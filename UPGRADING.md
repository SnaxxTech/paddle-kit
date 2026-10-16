# Upgrading paddle-kit

paddle-kit ships as git tags (`github:SnaxxTech/paddle-kit#vX.Y.Z`). Every upgrade is the same three steps, in this order.

## 1. Read the CHANGELOG first

Open [CHANGELOG.md](CHANGELOG.md) and read every entry between your tag and the new one. Look for:

- **Behaviour change** lines: an event that used to be `ignored` and is now `processed`, a new HTTP status, a reason code that moved.
- **New migrations**: a new `migrations/NNN_*.sql` file (also a new entry in `MIGRATIONS` / `SQLITE_MIGRATIONS`).
- **New `ReasonCode` members**: they break an exhaustive `switch` that ends in a `never` check. Add the case.

## 2. Run the new migrations, before deploying the new code

Migrations are additive (`CREATE ... IF NOT EXISTS` on `paddle_*` tables) and never edited once shipped, so running them on the old code is harmless. Running new code on a database without them is not: the webhook answers 500 `store_error` until they exist (Paddle retries, so nothing is lost, but health turns red).

- Postgres: apply each new file from `node_modules/paddle-kit/migrations/` with your migration tool, or execute every `MIGRATIONS[i].sql` from `paddle-kit/postgres` (re-running old ones is a no-op).
- SQLite: execute every `SQLITE_MIGRATIONS[i].sql` from `paddle-kit/sqlite` at startup.

Check first that your database has no tables of the new names with a different shape: `IF NOT EXISTS` would silently keep yours.

## 3. Bump the tag

```bash
npm i github:SnaxxTech/paddle-kit#v0.4.0
```

Commit the `package.json` and lockfile change. CI needs the `PADDLE_KIT_READ_TOKEN` secret (see the README checklist). Then run the app's own tests and its sandbox end-to-end check.

## Per-version notes

### 0.3.x → 0.4.0

1. **Migration `002_claims_transactions`** adds `paddle_event_claims` and `paddle_transactions`. Run it before deploying 0.4.0.
2. **Shared seller account?** (Every SnaxxTech app is on one.) Pass `owns: config.owns` from `readBillingEnv` to `createBilling`, then **delete the app's hand-written "not our product" filter** in `onTransaction`. Keep anything the filter did beyond ownership, such as checking the order marker in `customData`.
3. **`onAdjustment` gets `ctx.known`.** `false` = the kit never saw the transaction as yours: the payment may arrive later. Record such a refund; never return early on it. Transactions received before 0.4.0 were never recorded, so their refunds arrive with `known: false` too.
4. **409 `in_progress`.** A duplicate delivery that arrives while the first one is still running its hooks now answers 409 instead of running the hooks a second time. Paddle retries it, and the retry is a 200 duplicate. Dashboards that alert on any non-2xx from Paddle will see these; they are not failures.
5. `reconcile()` returns `{ scanned, applied, notOurs }`. A strict equality check on the old shape needs the new field.
6. `ReasonCode` gained `not_ours`.
