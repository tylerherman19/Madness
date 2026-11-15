# Remediation of the 2026-11-14 audit

Baseline: `main` at `52886c2` (the audited commit; unchanged on GitHub when this work began).
Production checked read-only on 2026-11-15 before any change.

## Production facts verified (read-only)

| Fact | Evidence |
|---|---|
| Production Supabase project is `ugyimdqnyanmxayhdvje` ("March-1", Free plan, no provider backups/PITR) | Dashboard; iOS `Supabase.plist`; `record-backup-check.mjs` |
| Migrations 032, 033, 034 are live; reverted 030 is **not** (no `players.pool_id`) | Catalog queries (no migration-history table exists; migrations were applied by hand) |
| `save_pick` and `enforce_pick_integrity` byte-match the repository | `md5(prosrc)` comparison |
| Mobile functions match the `native-ios` branch source (whitespace/comment-normalized md5) for `get_standings`, `get_slate_picks`, `get_entry_picks`, `submit_pick` and helpers; production `get_pool_summary` already lets an owner count their own test entry | Normalized `md5(prosrc)` comparison |
| INT-01 is present in production | Production `get_standings` = branch source; reproduced in `scripts/test-mobile-privacy.mjs` |
| `bump_rate_limit` executable only by `postgres`, `service_role` (SEC-09 item already fixed in production by the mobile migration) | `information_schema.routine_privileges` |
| `audit_log` has no foreign keys and no triggers | `pg_constraint`, `pg_trigger` |
| No Storage buckets existed | `storage.buckets` |
| Vercel production: `TOURNAMENT_RELIABILITY_ENABLED=true`, `AUTOMATION_V2_ENABLED=true`, `OUTBOX_DELIVERY_ENABLED=false` (email stays record-only) | Vercel project settings |
| Scheduler: pg_cron `madness-independent-workers` (every minute), `madness-schedule-sync` (*/15), `madness-retention` (hourly), all active and succeeding; every `recurring:*` job succeeded within minutes; no open incidents | `cron.job`, `cron.job_run_details`, `operation_runs`, `incidents` |
| GitHub "Operations monitor" workflow is `disabled_manually` since 2026-11-08; GitHub-side flags are both `true`; pg_cron is the active scheduler | Public Actions API (workflow state, job list) |
| Production deploys come from the Vercel GitHub integration (team `march14`, project `madness`) | GitHub Deployments API |

## Rollout order

1. Merge the PR. Vercel deploys the application. **No application code depends on migrations 035 or 036**; the code is correct on the current schema under both values of `TOURNAMENT_RELIABILITY_ENABLED`.
2. Confirm `/api/health` reports the merge revision.
3. Capture current definitions (rollback copy): `pg_get_functiondef` for `public.get_standings()`, `get_entry_picks(uuid)`, `get_slate_picks(uuid)`, `get_pool_summary()`.
4. Apply `035_mobile_read_privacy.sql`, then `036_seed_rule_and_append_only_audit.sql`, in the SQL editor. Both are guarded, idempotent and additive.
5. Re-run the catalog checks (function md5, triggers present).

Rollback: application — redeploy the previous production deployment (no schema dependency). 035 — re-create the captured definitions. 036 — `drop trigger picks_tournament_seed_only on public.picks; drop trigger audit_log_append_only on public.audit_log;` (and the sandbox equivalents).

## Backups (SEC-01, REL-06)

The nightly workflow now also stores both encrypted archives in the private Storage bucket `madness-backups` on the existing project (no new service or cost), proves each copy is unreadable without credentials, downloads it, decrypts it and restores it into an isolated in-memory database, and prunes copies older than 30 days (always keeping the newest 7 days). `BACKUP_ENCRYPTION_KEY_PREVIOUS` (optional secret) lets retained archives decrypt after a key rotation.

Retiring the public artifact is deliberately a second step, after one scheduled run of the new step has succeeded:
1. Confirm the "Store and verify a private copy" step passed and the bucket holds today's two archives.
2. Remove the `upload-artifact` and artifact reverify steps from `backup.yml`.
3. Delete the existing `encrypted-madness-backup-*` artifacts.
4. Rotate: set `BACKUP_ENCRYPTION_KEY_PREVIOUS` to the old value and `BACKUP_ENCRYPTION_KEY` to `openssl rand -base64 48`. Treat password hashes in already-downloaded artifacts as exposed to offline guessing if the old passphrase was not random.

Residual: the private copy lives in the same Supabase project. It covers bad writes, deletions and the public-artifact exposure; it does not cover loss of the project. A second home needs either a paid plan (PITR) or a second store, which is an owner decision.

## Decisions left to the owner

- **SEC-04:** session-secret enforcement is an environment setting. Default behaviour is unchanged so a weak value can never lock every entrant out on deploy; see the PR for the verified production state and the owner step.
- **INT-04 / entries:** whether one person may hold several entries, and whether unpaid entries count, are rules questions. Independent safeguard shipped: signup limited to 30 per network address per hour (was 1,000) plus the existing 5 per email. The published rules are unchanged.
- **INT-05:** the public "has picked" flag before lock is kept (website and app show the same thing); hiding it is a product choice.
- **REL-07:** make-good rule for entries restored after a later day locked remains a rules decision.
- **Operations monitor:** left disabled; pg_cron is the active scheduler and is healthy. Re-enabling the GitHub workflow would duplicate the worker.

## Disposition by report ID

| ID | Disposition |
|---|---|
| SEC-01 | Fixed (phase 1): private Storage copy, verified non-public and restorable; artifact retirement and key rotation follow one verified run (steps above) |
| SEC-02 | Out of scope by instruction (mobile sign-in) |
| SEC-03 | Out of scope by instruction (admin identity, MFA, throttling, pick visibility); transactional audit partly addressed under SEC-08 |
| SEC-04 | Owner step (see above); code unchanged by design |
| SEC-05 | Fixed: both pick paths and the admin login parse return 400 with no incident, audit row or alert; regression test, red on baseline |
| SEC-06 | Fixed: per-account cap across networks (100/h, counted after per-network limits), constant-work password check; limiter keeps local fallback (not fail-closed) |
| SEC-07 | Fixed for read functions (035); sign-in linking part out of scope with SEC-02 |
| SEC-08 | Fixed: append-only `audit_log` (036); reasons required and audited for player/game deletes; contact export audited. Remaining: moving eliminate/delete into same-transaction RPCs |
| SEC-09 | Fixed: constant-time cron check, no raw DB text in admin errors, typed admin edits, CSV email validation, CI permissions; `bump_rate_limit` already revoked in production. Deferred: token purpose claims, legacy `?token` reset URL, CSP inline scripts, action pinning |
| INT-01 | Fixed (035); production leak reproduced and regression-tested for current day and early next day |
| INT-02 | Out of scope by instruction |
| INT-03 | Fixed: reserved domain refused at public signup, admin create, import and admin email edit; sandbox fixtures unaffected |
| INT-04 | Safeguard: 30 signups/h per network (was 1,000); entry/payment rules left to the owner |
| INT-05 | Kept by decision (public "has picked" for the active day); early next-day flag no longer exposed |
| INT-06 | Fixed (036) for new writes; historical rows unchanged |
| INT-07 | Deferred: requires app-clock ahead of DB clock plus a mobile submit; both clocks NTP-synced |
| INT-08 | Already required a reason on `main`; inputs now validated. Same-transaction RPC remains |
| REL-01 | Out of scope by instruction |
| REL-02 | Verified healthy (pg_cron jobs, recurring runs, flags recorded above) |
| REL-03 | Fixed: clear 409 and on-page notice; DB error mapped |
| REL-04 | Fixed: lock never moves later; earlier moves audited, actionable ones raise an incident, players warned |
| REL-05 | No code change; existing fail-closed sync verified by suites |
| REL-06 | Fixed (phase 1) with SEC-01; same-project limitation recorded |
| REL-07 | Rules decision for the owner |
| REL-08 | Production verified against repo and mobile source; mobile schema kept as a test fixture (not a migration, which would undo 034) |
| USE-01..06 | Fixed (browser regressions for 01, 03, 05; units for 02, 04) |
| USE-07, 08, 09, 12, 13, 15 | Not changed in this release (display/copy; not independently verified by the audit) |
| USE-10 | Fixed: grade confirmation, reasons for deletes, bulk paid reports results |
| USE-11 | Out of scope with INT-02 |
| USE-14 | Fixed: recovery page says the organizer can enter the pick |
