# Madness operational release — October 17, 2026

The owner requested the checklist improvements except MFA and enterprise features, and authorized merging the tested changes. Shared organizer access remains unchanged. This release adds operational tools; it does not create enterprise identity, billing or compliance features.

## What ships

- Turnover targets 3 a.m. America/Chicago across daylight saving changes. Overnight assignment and result backstops precede turnover. Advancement refreshes results, waits for finals, completes assignments, grades, and then activates the next playing day. Provider failure leaves the current day active. Recovery continues after 4 a.m. and can catch up multiple overdue playing days without advancing the current playing day early. There is no invented cancellation/void-game rule; unresolved games require organizer review.
- Migration 024 adds durable operation claims with expiring ownership tokens, retry backoff, review after repeated failure, and fenced assignment writes/completion. Worker batches contain at most 50 entries. Snapshot schedules and pre-lock AP rankings govern durable auto-picks. Expected player quota state and expected active slate are checked again in PostgreSQL. Old unresolved dates rotate rather than starving later recovery work.
- The independent GitHub Actions operations workflow checks the public database-backed health endpoint every five minutes. With the configured secrets and feature flags it also checks job freshness and invokes the worker without player visits. GitHub schedules can be delayed; this is not an exact-minute SLA. Use a minute-capable scheduler if exact tip-time execution is required. No paid hosting upgrade is made.
- Deadline-relative reminder events target the two-hour and thirty-minute windows. The sender rechecks the current lock, player status, shared-round quota, preferences and suppression list. Notifications use provider idempotency keys and fenced acknowledgements. Old events are held for review after 23 hours; provider retries never intentionally cross the 24-hour idempotency window. A recorded `sent` status means provider acceptance, not proof of inbox receipt.
- Resend bounce and complaint callbacks require a valid timestamped signature and persist recipient suppression. `/notifications` lets a signed-in player turn reminder/elimination emails off. No new outbound email activation is performed.
- `/admin/operations` lists recent jobs and notifications needing review, provides reasoned retries and previews retention. Retry APIs reject already-completed items, active claims and expired notification retry windows. No personal email content appears in that operations view.
- Nightly backup workflow creates a consistent application snapshot, encrypts it with AES-256-GCM, restores it into an isolated PostgreSQL fixture, and reconciles counts, row digests and pick/game ownership references before uploading the encrypted artifact. Backup keys are kept separate from artifacts. A pre-migration production snapshot was encrypted and successfully restored into an isolated fixture: 16 tables and 2,115 rows reconciled. This does not establish provider point-in-time recovery.
- Operational retention removes completed job records older than 30 days and revocation records expired for seven days, and clears old notification payloads after 30 days. It does not delete picks, entries, contest archives, open disputes or audit history. Dry-run counts are available before an organizer applies cleanup; the enabled worker performs this bounded cleanup daily.
- CI includes browser flows, operational database tests, backup restore tests and a runtime dependency security gate. Dependabot checks npm weekly and Actions monthly. Supabase and provider fetches are time-bounded. Error reporting redacts credentials and email addresses; authenticated CSV responses disable caching.

## Activation prerequisites

Code merge and production activation are distinct. The owner opened Supabase project `March-1` (`ugyimdqnyanmxayhdvje`). Migrations 022 and 023 were verified; migration 024 was rehearsed in the sandbox, then applied to production after a successful encrypted backup and isolated restore. The deployed project has additional account/preference/device tables and columns; the backup includes these and the restore reconciles them. Sending-domain configuration and outbound email activation remain separate.

1. Confirm the Madness Supabase project and an isolated staging target. Take and verify a backup before modifying the live schema. Verify 022 and 023 are present; apply only missing additive migrations in order, then `024_operations.sql`. Never replay destructive legacy migration 014 against an existing project. Rehearse the new migration and permission checks in staging before production.
2. Run `npm run test:operations`. This applies repository migrations only inside isolated local databases. Verify real staging grants: anonymous/authenticated clients cannot read operation runs, outbox contents, suppressions, archives or session revocations, and cannot invoke administrative functions. Verify migration/readiness against the actual production project separately.
3. Set a random `MONITOR_SECRET` in both Vercel production and GitHub Actions secrets. Set GitHub's `CRON_SECRET` to the existing Vercel cron credential. Never place production credentials in preview targets. Set Vercel production `AUTOMATION_V2_ENABLED=true` only after the migration passes. Set the GitHub repository variable of the same name to `true` to schedule traffic-independent work.
4. Exercise `/api/operations/health` with the monitor bearer token. Confirm a failed job can be detected externally and the organizer receives the intended GitHub Actions failure notification. This workflow surfaces failed checks in Actions; account notification preferences determine whether GitHub emails a person. Configure a pager/monitor destination separately if required.
5. For backups, configure GitHub secrets `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and a separate random `BACKUP_ENCRYPTION_KEY` of at least 32 characters. Grant the repository secret access only to the intended repository; keep artifacts encrypted in public repositories. Set repository variable `BACKUPS_ENABLED=true`. Run the workflow manually and confirm the encrypted artifact and successful isolated restore. Current artifact retention is 14 days. Keep the encryption key in a separately recoverable secure store. Verify the Supabase plan's own backup/PITR capabilities separately.
6. For email, verify sending-domain SPF, DKIM and DMARC with the provider; configure `RESEND_WEBHOOK_SECRET` and the signed `/api/webhooks/email` callback. Validate delivery, bounce and complaint handling with authorized test recipients. Only then set both `EMAILS_ENABLED=true` and `OUTBOX_DELIVERY_ENABLED=true`. Password-reset delivery retains its separate flag. No historical queue is automatically blasted on activation.

## Operating schedule

| Action | Time / trigger | Activation |
| --- | --- | --- |
| Lock and reveal | First published tip; database checks enforce the deadline | Existing core rules |
| Missing-pick processing | Worker checks roughly each minute during an Actions run; bounded 50-entry batches | Operations migration, both worker flags and cron secret |
| Overnight assignment backstop | 06:00 UTC: 1 a.m. CDT / midnight CST | Existing daily cron |
| Overnight results backstop | 07:00 UTC: 2 a.m. CDT / 1 a.m. CST | Existing daily cron |
| Turnover | Starts at 3 a.m. Central; retry after an outage, gated on completed assignment/results/grading | Existing cron; durable deduplication when v2 enabled |
| Result recovery | Every five-minute worker slot; active date once its Central calendar day arrives, plus up to three older unfinished dates | Enabled worker |
| Reminder queue | First worker run in the 2h and 30m pre-lock windows | Enabled worker |
| Delivery queue | Up to ten messages per worker run | Separate delivery switches and provider configuration |
| Organizer summary | 13:00 UTC: 8 a.m. CDT / 7 a.m. CST | Existing schedule; delivery flags/recipient still required |
| Uptime check | GitHub Actions every five minutes, subject to platform delay | Workflow on main |
| Job-freshness check | Alongside uptime; ten-minute worker threshold and overdue turnover after 3:15 a.m. | Monitor secret and worker activation |
| Encrypted backup + restore drill | 10:30 UTC daily | Backup secrets and repository flag |
| Operational retention | Once per Central date on a worker run | Enabled worker |

## Recovery and rollback runbook

1. Inspect `/admin/operations`, the audit log and GitHub Actions. A running claim expires after four minutes. Inspect review items and their underlying cause before requesting a retry with a reason. Fix credentials/provider outage first; do not repeatedly release a failing job.
2. If a deadline passed during an outage, use frozen assignment state. Do not change published locks to make late picks look timely. An expired/incomplete snapshot, unresolved game or ambiguous result requires a recorded organizer decision; no result replay or cancellation policy is invented here.
3. Disable `OUTBOX_DELIVERY_ENABLED` first if notices are wrong, then `AUTOMATION_V2_ENABLED` and the matching GitHub variable if work must stop. Keep the ordinary health monitor running. These are environment changes requiring a new Vercel deployment; do not rely on a variable edit changing an already-built deployment.
4. Restore known-good application code when needed. After credential rotation, redeploy that revision with the current environment and verify it; promoting an older deployment can restore a retired credential. Migration 024 is additive; leave it installed for an application rollback. Do not drop operational data or replay all migrations as a rollback strategy.
5. To rehearse recovery locally: `BACKUP_ENCRYPTION_KEY=... node scripts/restore-check.mjs backup.json.enc`. This utility deliberately has no live database target and restores only into a new in-memory PostgreSQL instance. Use the matching repository revision for old snapshots.
6. For an actual disaster, restore into a separate secured database, reconcile application tables and grants, invalidate old sessions/worker leases, review pending notices to avoid resend, and test login/picks/results before switching application credentials. Preserve the original database for investigation. Target recovery objectives: no more than 24h application-data loss under the nightly schedule; rehearse a one-hour recovery target. These are targets, not measured production guarantees.
7. Record the incident timeline, restored backup timestamp, count/digest checks, corrective change and verification result. Test this procedure at least annually and before a major contest launch.

## Privacy and support procedure

Honor access/correction requests using authenticated exports and the organizer's audit tools. For deletion, first resolve active entry/payment/dispute obligations; identify the player's entries, picks, notification payloads, archived copies and audit references. Apply an approved anonymization/deletion plan transactionally, verify related tables, and record a minimal request/completion receipt. Encrypted backup artifacts expire after 14 days under the configured workflow; provider backups have a separate policy that must be confirmed. Do not claim a request has reached every backup until that retention is verified. No automatic deletion of competition evidence or unrecoverable player purge is introduced in this release.

## Validation record

See the PR checks for the exact head revision. Required checks are TypeScript, unit tests, original public/sandbox regressions, new operational regressions, encrypted restore reconciliation, browser flows, lint and production build. Browser tests use synthetic accounts in a loopback-only PostgreSQL adapter and stub upstream sports feeds. They do not create real accounts, send email, load-test production or certify provider behavior. Runtime npm audit is clean after compatible updates; the development-only braces/ESLint dependency chain still reports advisories without a compatible fix. No forced framework downgrade is made.
