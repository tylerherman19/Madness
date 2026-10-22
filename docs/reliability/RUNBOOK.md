# Rollout, activation and recovery

Initial implementation did not change production. The subsequent merge authorization permits the reviewed application merge; database and email activation remain separate. Keep `EMAILS_ENABLED=false`, `OUTBOX_DELIVERY_ENABLED=false`, `PASSWORD_RESET_EMAILS_ENABLED=false` and database mode `record-only` throughout implementation and initial staging. Never put real player credentials or real recipient lists in load fixtures.

## Rollout order

1. Identify the deployed Supabase project from trusted deployment configuration. Inspect applied migrations/functions/RLS with read-only queries. Do not assume the currently open dashboard project is the correct one.
2. Verify an encrypted pre-change backup and restore it into an isolated database. Retain source revision, migration list and encryption keys separately. Existing migrations 001–024 include historical destructive setup: **never rerun them on production**.
3. Apply only additive 025, 026, 027 to an isolated copy with matching prerequisites. Run `npm ci`, typecheck, unit tests, `test:db`, `test:operations`, `test:tournament`, browser tests and the real PostgreSQL concurrency suite. Existing legacy tests deliberately cover the pre-025 schema; the new suite executes the entire chain.
4. Configure a separate hosted staging database and preview environment. Set `PREVIEW_DATABASE_CONFIRMED=true` only after confirming isolation. Preview DB access otherwise fails closed. Keep email switches false.
5. Run the staged load scenarios below; record actual plan, region, limits, latency and errors. Verify policy/RPC exposure as anonymous/authenticated roles. Check record-only campaign/assignment completion and restore the resulting snapshot.
6. Production migrations and worker/email activation require their operating authorization. The application can be merged first with `TOURNAMENT_RELIABILITY_ENABLED` absent/false: normal picks use the existing acceptance path, with provider calls removed, until schema verification and activation. Apply 025–027 together during a quiet window, then deploy the matching application with email still off. Do not delete old queued work or reset/seed contest data.
7. Set `AUTOMATION_V2_ENABLED=true` and `TOURNAMENT_RELIABILITY_ENABLED=true` only after new schema readiness. Enable the new scheduler and verify each workload's actual progress. The two flags also control the GitHub fallback job via repository variables; keep deployment and repository values consistent.
8. Prefer the reviewed Supabase Cron/pg_net/Vault template in `scheduler.sql` for regular invocation. Configure extensions, Vault secrets and endpoint authentication explicitly. The template is intentionally not a migration. Monitor pg_net responses and workload success independently. GitHub remains an independent monitor/fallback, with no precise cadence promise.
9. Verify operations health immediately and through a full simulated tournament day. A healthy HTTP endpoint does not prove assignments, grading, campaigns or reminders completed.

## Email connection and activation — separate deliberate action

- Confirm the intended paid Resend account, account-enforced allowance/rate, overage policy and any spending decision with the owner. Do not purchase/upgrade here.
- Verify sender domain/DNS and `pool@pickandpray.org`, API-key scope and sender identity. Store key server-side.
- Configure signed webhook endpoint and `RESEND_WEBHOOK_SECRET`; verify acceptance/delivery, bounce and complaint callbacks, duplicates and delayed order using allowlisted addresses only.
- Generate `RECOVERY_EMAIL_KEY` (32 random bytes, base64) through the secret manager; store separately from DB backups. Retain keys needed for unexpired encrypted messages. No recovery tokens in query history, screenshots, ordinary logs or admin previews.
- With explicit test-send authorization, enable master/outbox switches and choose **Test recipients** with an explicit allowlist and reason. Use a new campaign created after the activation boundary. Confirm non-allowlisted records remain held. Recovery additionally requires its separate switch.
- Check actual throughput, suppression, reminders that become complete, expired reminders, provider quota pause and retry timing. Test reset expiry/supersession independently of optional announcement preferences.
- Before live, inventory held/pending/processing/review records and campaign creation times. Mode changes hold queued records and never release historical mail. Old/test campaigns expanded later stay held. Cancel historical tests and create a new, explicitly reviewed live campaign. Do not bulk-release held mail.
- Live mode requires separately approved server configuration `LIVE_EMAIL_ACTIVATION_APPROVED=true`, the master/outbox switches and provider key, followed by an authenticated, audited mode change with reason. Set this only after separate authorization.
- Verify dashboard mode actor/time, test results, monitoring, backup/restore, account allowance and scheduler cadence. Acceptance is not delivery; delivery is not reading.

## Targets and staged scenarios

Targets to validate, not claims already demonstrated: pick API p95 <=500ms / p99 <=1s under the intended deadline burst; assignments of 2,000 eligible entries <=5 minutes after lock; normal results freshness <=2 minutes; no eligible delivery backlog older than its SLA; 1,000 reminder requests accepted by the provider <=10 minutes, subject to verified account limits and actual scheduler/DB/provider performance.

- `LOAD_TEST_ACK=ISOLATED_STAGING LOAD_TEST_URL=<staging> LOAD_TEST_CONCURRENCY=1000 LOAD_TEST_SECONDS=30 node scripts/load-staging.mjs` exercises shared viewers. Production hostname is explicitly blocked.
- For pick bursts, provide `LOAD_TEST_MODE=pick` and `LOAD_TEST_FIXTURES=<restricted JSON file>` with at least 2,000 staged entries. Each fixture is `{cookie,pick:{slate_id,team,pick_id?,expected_version?},requestId}`. A request ID identifies one action; replay fixtures measure retries, not independent changes. Provide distinct fixture files for insert/change races. Never commit sessions.
- `CONCURRENCY_TEST_ACK=EMPTY_DISPOSABLE_DATABASE STAGING_DATABASE_URL=<empty local/staging Postgres> node scripts/test-postgres-concurrency.mjs` refuses nonempty public databases, installs the fixture schema and tests real multi-connection races/lock waits. It never has a production default.
- Run a 1,000-recipient provider-connected wave only with explicit test-recipient authorization and account allowance. Record request start/acceptance, queue age/drain, retries and callbacks; do not infer performance from mocked sends.

## Interrupted work

- Jobs: allow the lease to expire; the next authenticated invocation claims unfinished work. Review exhausted retries in System → Background jobs. Correct the cause and retry with a reason; never clear active ownership tokens.
- Assignments: accepted picks and documented eliminations survive; missing quota counts identify unfinished entries. Never substitute new rankings/results for frozen inputs. Missing snapshots require review.
- Email: same message ID and frozen payload on uncertain retry; same provider idempotency key. More than 23 hours after first attempt, do not resend blindly. Reconcile with provider logs/message ID and signed events. No manual action can make an already accepted email unsent.
- Campaign: audience cursor and unique recipient records resume without duplicates. Cancellation stops remaining unsent rows; in-flight requests may already have reached Resend.
- Corrections: inspect incident/game history, regrade current results, explicitly restore disputed entries with a reason, inspect downstream eligibility and notification history. Keep superseded notices as historical evidence; do not rewrite them to appear current.

## Backup and rollback

`contest_backup` refuses unknown tables and now covers all 23 current application tables, including encrypted recovery payloads, campaigns, recipients, attempts, events, receipts, revisions, rules, checks and incidents. The restore harness compares complete row digests and basic orphan checks in isolation. A data snapshot is not a replacement for schema migrations, RLS, Vault secrets, cron configuration or deployment settings.

Run backups/retention outside pick-deadline traffic: the existing consistent snapshot uses table share locks. Keep encryption key, matching source revision and schema separately. Restricted reset bodies are scrubbed after expiry plus one day; general content/recipient payloads after 30 days; attempts/events/checks after 90 days. Contest picks/revisions/audits remain retained. Decide the final contest evidence retention period with the organizer before archival cleanup.

To pause: turn email master switch off, set record-only mode, disable new scheduler dispatch and repository worker variable. Preserve all queue/receipt records. Already-started provider requests cannot be recalled. To roll back application code, retain additive schema and data; do not drop new tables. Old app binaries do not satisfy new operational semantics, so keep delivery and old worker paths paused until a reviewed recovery/redeployment. Verify applied function definitions and role grants after any schema recovery.

Recovery dashboard intentionally shows backup/restore telemetry as unavailable unless independently observed; inspect the actual backup workflow artifact and restore result. Do not substitute a fabricated timestamp.
