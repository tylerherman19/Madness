-- Read-only readiness audit. Run against the verified deployment project.
begin read only;
select current_database(), current_user, current_setting('server_version') as postgres_version;
select schemaname,tablename,rowsecurity from pg_tables where schemaname in ('public','sandbox') and tablename in ('pick_requests','pick_revisions','delivery_settings','notification_attempts','provider_events','email_campaigns','campaign_recipients','integrity_checks','incidents');
select n.nspname,p.proname,has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','sandbox') and p.proname in ('save_pick','request_password_reset','set_delivery_mode','claim_notifications','record_provider_event','expand_campaign','contest_backup');
select column_name,data_type from information_schema.columns where table_schema='public' and table_name='picks' and column_name in ('version','game_id','team_id');
select mode,changed_at,changed_by,paused_until,pause_reason from public.delivery_settings;
select key,status,attempts,last_success_at,next_attempt_at,lease_until,correlation_id from public.operation_runs where key like 'recurring:%';
select id,observed_at,findings from public.integrity_checks order by observed_at desc limit 1;
rollback;
-- Check the platform migration registry separately if available. Functions/tables
-- present are evidence of shape, not proof of a particular reviewed migration hash.
