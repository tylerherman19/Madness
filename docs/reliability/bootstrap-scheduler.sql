-- ONE-TIME REVIEWED CONFIGURATION HELPER. Not an automatic migration.
-- Install only in verified Madness project ugyimdqnyanmxayhdvje, after separately
-- installing pg_cron, pg_net and supabase_vault and verifying migrations 025-027.
-- The manual GitHub workflow supplies its existing CRON_SECRET as a bound RPC
-- parameter. Never paste that value into SQL, logs, files or browser forms.
-- First invoke with p_enable=false; inspect fixed jobs, then invoke true only
-- after the matching app/flags are deployed. Email must remain disabled.
-- DROP THIS FUNCTION IMMEDIATELY after successful configuration and verification:
--   drop function public.bootstrap_madness_scheduler(text,boolean);
--   notify pgrst, 'reload schema';
-- Official APIs: https://supabase.com/docs/guides/database/vault
-- https://supabase.com/docs/guides/cron/quickstart
-- https://supabase.com/docs/guides/database/extensions/pg_net
begin;
create or replace function public.bootstrap_madness_scheduler(
 p_cron_secret text,
 p_enable boolean default false
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog
as $bootstrap$
declare
 canonical_url constant text := 'https://madness-cyan.vercel.app';
 job_names constant text[] := array['madness-independent-workers','madness-schedule-sync','madness-retention'];
 stored_value text;
 secret_count integer;
 job_id bigint;
 configured integer := 0;
begin
 if p_enable is null or p_cron_secret is null
    or octet_length(p_cron_secret) not between 16 and 512
    or p_cron_secret ~ '[[:cntrl:]]' then
  raise exception 'Invalid scheduler configuration input';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('madness.scheduler.bootstrap',0));
 if (select count(*) from pg_extension where extname in ('pg_cron','pg_net','supabase_vault')) <> 3
    or to_regclass('cron.job') is null
    or to_regclass('vault.decrypted_secrets') is null
    or not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='cron' and p.proname='schedule')
    or not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='cron' and p.proname='alter_job')
    or not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='net' and p.proname='http_get')
    or not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='vault' and p.proname='create_secret') then
  raise exception 'Reviewed scheduler extensions and APIs must already be installed';
 end if;
 if to_regclass('public.pick_requests') is null
    or to_regclass('public.pick_revisions') is null
    or to_regclass('public.operation_runs') is null
    or to_regclass('public.delivery_settings') is null
    or to_regclass('public.audit_log') is null
    or to_regprocedure('public.finish_recurring_operation(text,uuid,integer,jsonb)') is null
    or to_regprocedure('public.delivery_retention()') is null then
  raise exception 'Verified tournament reliability schema is required';
 end if;
 if not exists(select 1 from public.delivery_settings where id=true and mode='record-only') then
  raise exception 'Delivery must remain record-only during this activation';
 end if;
 if exists(select 1 from cron.job where jobname=any(job_names) and username<>current_user) then
  raise exception 'A reviewed job name belongs to another database role';
 end if;

 -- Do not rotate an existing value or accept a different endpoint. A rerun
 -- reuses matching values and rejects drift rather than overwriting it.
 select count(*),min(decrypted_secret) into secret_count,stored_value
 from vault.decrypted_secrets where name='madness_base_url';
 if secret_count=0 then
  perform vault.create_secret(canonical_url,'madness_base_url','Canonical reviewed Madness worker origin');
 elsif secret_count<>1 or stored_value is distinct from canonical_url then
  raise exception 'Existing scheduler origin requires review';
 end if;
 select count(*),min(decrypted_secret) into secret_count,stored_value
 from vault.decrypted_secrets where name='madness_cron_secret';
 if secret_count=0 then
  perform vault.create_secret(p_cron_secret,'madness_cron_secret','Existing Madness cron authorization, copied by the manual configuration workflow');
 elsif secret_count<>1 or stored_value is distinct from p_cron_secret then
  raise exception 'Existing scheduler authorization requires review';
 end if;
 stored_value := null;

 -- Fixed SQL only. The origin predicate fails closed if the Vault origin is
 -- later changed; no credential is interpolated into stored job command text.
 job_id := cron.schedule('madness-independent-workers','* * * * *',$workers$
  select net.http_get(
   url := (select decrypted_secret from vault.decrypted_secrets where name='madness_base_url' and decrypted_secret='https://madness-cyan.vercel.app')
     || '/api/cron/worker?workload=' || workload,
   headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='madness_cron_secret')),
   timeout_milliseconds := 220000
  ) from unnest(array['results','grading','assignment','advance','reminders','campaigns','delivery','integrity']) workload;
 $workers$);
 perform cron.alter_job(job_id,active:=p_enable);
 configured := configured+1;
 job_id := cron.schedule('madness-schedule-sync','*/15 * * * *',$schedule$
  select net.http_get(
   url := (select decrypted_secret from vault.decrypted_secrets where name='madness_base_url' and decrypted_secret='https://madness-cyan.vercel.app')||'/api/cron/worker?workload=schedule',
   headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='madness_cron_secret')),
   timeout_milliseconds := 220000
  );
 $schedule$);
 perform cron.alter_job(job_id,active:=p_enable);
 configured := configured+1;
 job_id := cron.schedule('madness-retention','0 11 * * *',$retention$
  select net.http_get(
   url := (select decrypted_secret from vault.decrypted_secrets where name='madness_base_url' and decrypted_secret='https://madness-cyan.vercel.app')||'/api/cron/worker?workload=retention',
   headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='madness_cron_secret')),
   timeout_milliseconds := 220000
  );
 $retention$);
 perform cron.alter_job(job_id,active:=p_enable);
 configured := configured+1;
 if (select count(*) from cron.job where jobname=any(job_names) and username=current_user and active=p_enable) <> 3 then
  raise exception 'Reviewed job state could not be verified';
 end if;
 insert into public.audit_log(event_type,actor,message,details)
 values('scheduler-configured','system','Reviewed Madness scheduler configuration applied',
  jsonb_build_object('source','restricted-service-role-bootstrap','enabled',p_enable,'job_names',job_names,'configured',configured));
 return jsonb_build_object('ok',true,'enabled',p_enable,'configured',configured,'base_url',canonical_url,'job_names',job_names);
exception when others then
 -- Never surface a Vault/provider error, its context, or bound secret value.
 raise exception using errcode='P0001',message='Scheduler configuration failed; inspect prerequisites and reviewed job state without exposing secrets';
end;
$bootstrap$;
alter function public.bootstrap_madness_scheduler(text,boolean) owner to postgres;
revoke all on function public.bootstrap_madness_scheduler(text,boolean) from public,anon,authenticated;
grant execute on function public.bootstrap_madness_scheduler(text,boolean) to service_role;
comment on function public.bootstrap_madness_scheduler(text,boolean) is 'Temporary audited fixed Madness scheduler bootstrap; service-role-only; drop immediately after activation verification.';
notify pgrst,'reload schema';
commit;
