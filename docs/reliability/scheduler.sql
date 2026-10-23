-- MADNESS SCHEDULER SETUP AND READ-ONLY VERIFICATION REFERENCE.
-- This file does not create jobs. Do not paste secrets into SQL or job text.
-- The guarded one-time configuration path is bootstrap-scheduler.sql plus the
-- manual configure-scheduler.yml workflow; that workflow reuses existing
-- GitHub server-side secrets and accepts only the verified Madness project.
--
-- Reviewed sequence (operator authorization, not an automatic migration):
-- 1. Verify production project ugyimdqnyanmxayhdvje, migrations 025-027, grants,
--    backup/restore, contest state and retention candidates. Keep actual email
--    switches false and public.delivery_settings.mode='record-only'.
-- 2. Install pg_cron, pg_net and supabase_vault separately in the dashboard.
-- 3. Install bootstrap-scheduler.sql as postgres. The temporary RPC is a fixed
--    SECURITY DEFINER function executable only by service_role, not public users.
-- 4. Dispatch 'Configure reviewed Madness scheduler' on reviewed main with
--    enable=false. Existing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/CRON_SECRET
--    flow directly from GitHub secrets to the bound RPC; do not retrieve/rotate
--    their values. Confirm exactly the three expected inactive jobs below.
-- 5. Deploy and verify AUTOMATION_V2_ENABLED=true and
--    TOURNAMENT_RELIABILITY_ENABLED=true; align GitHub fallback variables.
--    Configure provider-independent prerequisites. Keep all email delivery off.
-- 6. Dispatch the same workflow with enable=true. Observe cron execution,
--    pg_net HTTP status and each recurring workload's actual progress. A
--    successful enqueue/HTTP response alone is not proof of completed work.
-- 7. Immediately DROP the temporary helper after successful setup and verify
--    to_regprocedure(...) is null. Retain only fixed jobs and Vault entries.
--    drop function public.bootstrap_madness_scheduler(text,boolean);
--    notify pgrst,'reload schema';
--
-- Fixed reviewed jobs configured by the helper:
-- madness-independent-workers: every minute; results, grading, assignment,
-- advance, reminders, campaigns, delivery, integrity (independent due times).
-- madness-schedule-sync: every 15 minutes; schedule.
-- madness-retention: hourly due check; cleanup runs at most once per 24 hours.
-- Hourly checks avoid missing a whole day when completion time drifts past an
-- exact daily invocation. Review eligibility before initial activation.
-- The application origin is exactly https://madness-cyan.vercel.app. Stored
-- job commands reference Vault values and fail closed if that origin changes.
--
-- These observations reveal no credentials or message/player payloads.
begin read only;
select jobid,jobname,schedule,active,username
from cron.job
where jobname in ('madness-independent-workers','madness-schedule-sync','madness-retention')
order by jobname;
select name,count(*) as configured_entries
from vault.secrets
where name in ('madness_base_url','madness_cron_secret')
group by name order by name;
select j.jobname,r.status,r.start_time,r.end_time
from cron.job_run_details r join cron.job j on j.jobid=r.jobid
where j.jobname in ('madness-independent-workers','madness-schedule-sync','madness-retention')
order by r.start_time desc limit 15;
select status_code,timed_out,count(*) as responses
from net._http_response
where created>clock_timestamp()-interval '15 minutes'
group by status_code,timed_out order by status_code nulls last,timed_out;
select key,status,attempts,last_success_at,next_attempt_at,lease_until
from public.operation_runs where key like 'recurring:%' order by key;
select to_regprocedure('public.bootstrap_madness_scheduler(text,boolean)') is null as temporary_helper_removed;
rollback;
-- Worker response bodies need restricted handling: assignment progress can
-- contain player names. The response itself does not identify the workload;
-- pair aggregate HTTP evidence with the explicit recurring:<workload> records.
--
-- To pause, use reviewed SQL as the owner to deactivate/unschedule all three
-- named jobs. Preserve queue/receipt records and keep email switches off.
-- Keep GitHub monitoring/fallback independently configured. Do not recreate
-- the dropped bootstrap helper for routine monitoring or normal deployments.
-- Official APIs: https://supabase.com/docs/guides/cron
-- https://supabase.com/docs/guides/database/vault
-- https://supabase.com/docs/guides/database/extensions/pg_net
