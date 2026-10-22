-- REVIEW / CONFIGURATION TEMPLATE ONLY. Not a migration. Do not execute in production yet.
-- Supabase Cron + pg_net, with the existing endpoint secret stored in Vault.
-- Configure extensions through the dashboard; store `madness_base_url` and
-- `madness_cron_secret` in Vault without putting values in Git, query history, or logs.
-- Confirm project is not paused and has adequate connection/pg_net capacity.
-- Keep GitHub monitor as an independent observer. Start only after staging tests.
-- Docs: https://supabase.com/docs/guides/functions/schedule-functions
-- Docs: https://supabase.com/docs/guides/cron
select cron.schedule(
 'madness-independent-workers', '* * * * *',
 $job$
 select net.http_get(
  url := (select decrypted_secret from vault.decrypted_secrets where name='madness_base_url')
    || '/api/cron/worker?workload=' || workload,
  headers := jsonb_build_object('Authorization','Bearer '||
    (select decrypted_secret from vault.decrypted_secrets where name='madness_cron_secret')),
  timeout_milliseconds := 220000
 ) from unnest(array['results','grading','assignment','advance','reminders','campaigns','delivery','integrity']) workload;
 $job$
);
-- Schedule sync independently every 15 minutes; retention daily outside deadline hours.
-- Jobs use durable due times, not the exact minute of invocation.
select cron.schedule('madness-schedule-sync','*/15 * * * *',$job$
 select net.http_get(url := (select decrypted_secret from vault.decrypted_secrets where name='madness_base_url')||'/api/cron/worker?workload=schedule',headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='madness_cron_secret')),timeout_milliseconds:=220000);
$job$);
select cron.schedule('madness-retention','0 11 * * *',$job$
 select net.http_get(url := (select decrypted_secret from vault.decrypted_secrets where name='madness_base_url')||'/api/cron/worker?workload=retention',headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='madness_cron_secret')),timeout_milliseconds:=220000);
$job$);
-- Pause: select cron.unschedule('madness-independent-workers');
-- Pause the other two names as well. Never delete queue records to pause workers.
