# Encrypted backups: storage, keys and recovery

This covers the nightly application backup (`.github/workflows/backup.yml`). It does not replace Supabase's own backups or point-in-time recovery. For broader incident handling, see [automation-release.md](automation-release.md).

## What the workflow does

1. It refuses to start unless `BACKUP_ENCRYPTION_KEY` is 32 random bytes and the private bucket exists and is not public.
2. It calls `contest_backup()` for `public` and `sandbox`. Each call returns a consistent snapshot of every application table and its column catalogue.
3. It encrypts each snapshot with AES-256-GCM, using the key directly, a fresh 96-bit nonce and a full 128-bit tag. The schema and creation time are stored in clear but authenticated.
4. It restores each archive into a new in-memory PostgreSQL built from the migrations and reconciles row counts and digests.
5. It uploads each archive to the private Supabase Storage bucket. Uploads never overwrite.
6. It downloads the archives back, checks the bytes match, decrypts and restores them again, and records the observation shown on Admin → System → Recovery.
7. It deletes this workflow's archives older than 14 days.

Archives are never uploaded as GitHub workflow artifacts, because the repository is public. If storage is not configured, the job fails before taking a backup. There is no fallback.

## One-time owner setup (required before merging this change)

1. In Supabase project `March-1` (`ugyimdqnyanmxayhdvje`), go to Storage → New bucket:
   - Name: `madness-backups`.
   - Public bucket: **off**.
   - Add no storage policies. Only the service role, which bypasses RLS, needs access.
2. Generate a new backup key with `openssl rand -base64 32`. Store it in your password manager first, then save it as the GitHub secret `BACKUP_ENCRYPTION_KEY` (replacing the old value).
   - Passphrase-style values are now refused.
   - Keep the old passphrase too: it is the only way to open archives made before this change.
3. Add the GitHub repository **variable** `BACKUP_STORAGE_BUCKET` = `madness-backups`.
4. Keep the existing secrets `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, and the variable `BACKUPS_ENABLED=true`.
5. Run the workflow manually (Actions → Encrypted backup and restore drill → Run workflow). Check that:
   - the run is green;
   - two objects appear under `public/` and `sandbox/` in the bucket;
   - Admin → System → Recovery shows a fresh observation.
6. Delete any remaining `encrypted-madness-backup-*` artifacts from earlier runs under Actions, or let them expire. They expire 14 days after their run.

Until steps 1–3 are done, the scheduled job fails at its first step and nothing is published. The Recovery page keeps showing the last verified observation, then "Unknown" once it is stale.

## Recovering data

1. Download the archive you need from the bucket (Storage → `madness-backups` → `public/…json.enc`) to a secured machine. Use the repository revision that matches its date.
2. Rehearse first, isolated: run `BACKUP_ENCRYPTION_KEY=… node scripts/restore-check.mjs path/to/archive.json.enc`.
   - It restores into a new in-memory database only and prints table and row counts. It has no live target.
   - For archives from before November 2026, put the old passphrase in `BACKUP_ENCRYPTION_KEY`.
3. For a real restore, create a separate secured database (a new Supabase project or branch). Apply the migrations in order. Then load the decrypted `tables` with service-role access, keeping the dependency order used by `restore-check.mjs`: teams, pools, slates, players, games, picks, then the rest.
   - Never restore over the live database.
   - Preserve the original database for investigation.
4. Verify before switching application credentials:
   - row counts per table;
   - an organizer and a player can sign in;
   - standings and `contest_counts()` match expectations;
   - pending notices are reviewed so nothing is re-sent.
5. Point the deployment at the restored database. Then rotate `SESSION_SECRET` to sign everyone out, which drops sessions issued against the old data.
6. Record the timeline, the archive timestamp, the checks and their results.

## Drill

`npm run test:operations` includes `scripts/test-backup-drill.mjs`. It runs entirely locally on PGlite:

1. It seeds a fixture contest with entries, an archived contest and its contest archive, slates, results, picks, audit rows, a revoked session and an outbox notice.
2. It backs the fixture up with `contest_backup()`, encrypts it to disk, reads it back, and restores it into a fresh database built from the migrations.
3. It checks the restored copy:
   - counts and digests for every table match the source database;
   - a restored player's bcrypt password verifies;
   - `contest_counts()` and the standings inputs match;
   - admin SQL functions (`active_pick_requirement`, `reconcile_contest`, `operation_retention`, and the reset-link functions) run.

Backups capture every column (`to_jsonb`). The restore recreates columns and tables that are newer than the checked-out migrations from the archive's own column catalogue. Nothing is silently dropped. A new application table without backup coverage makes `contest_backup()` fail loudly until it is added to its table list.
