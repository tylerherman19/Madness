-- Additive operational state. Apply only after 022 and 023, in staging first.
begin;
do $migration$
declare target text; ddl text;
begin
 foreach target in array array['public','sandbox'] loop
  ddl := $schema$
   alter table __SCHEMA__.players add column if not exists notifications_enabled boolean not null default true;
   create table if not exists __SCHEMA__.operation_runs (
    key text primary key, token uuid, lease_until timestamptz, attempts integer not null default 0,
    next_attempt_at timestamptz not null default now(), last_success_at timestamptz,
    status text not null default 'pending' check(status in ('pending','running','done','failed','review')),
    last_error text, updated_at timestamptz not null default now()
   );
   alter table __SCHEMA__.operation_runs enable row level security;
   revoke all on __SCHEMA__.operation_runs from anon,authenticated;
   grant all on __SCHEMA__.operation_runs to service_role;
   create or replace function __SCHEMA__.claim_operation(p_key text, p_seconds integer default 240)
   returns uuid language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
   declare claimed uuid;
   begin
    insert into __SCHEMA__.operation_runs(key) values(p_key) on conflict do nothing;
    update __SCHEMA__.operation_runs set token=gen_random_uuid(),lease_until=clock_timestamp()+make_interval(secs=>least(300,greatest(10,p_seconds))),
     attempts=attempts+1,status='running',updated_at=clock_timestamp()
     where key=p_key and status not in ('done','review') and next_attempt_at<=clock_timestamp()
      and (lease_until is null or lease_until<=clock_timestamp()) returning token into claimed;
    return claimed;
   end $fn$;
   create or replace function __SCHEMA__.finish_operation(p_key text,p_token uuid,p_done boolean,p_error text default null)
   returns boolean language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
   begin
    update __SCHEMA__.operation_runs set status=case when p_error is not null and attempts>=8 then 'review' when p_error is not null then 'failed' when p_done then 'done' else 'pending' end,
     -- An ordinary pre-lock/batched pass is successful, not a failed retry.
     -- Reset its streak so one later transient failure cannot exhaust retries.
     attempts=case when p_error is null and not p_done then 0 else attempts end,
     last_error=case when p_error is not null then 'Operation failed; inspect server logs using the operation key' else null end,
     last_success_at=case when p_error is null then clock_timestamp() else last_success_at end,
     lease_until=null,token=null,updated_at=clock_timestamp(),
     next_attempt_at=clock_timestamp()+make_interval(secs=>case when p_error is null then 0 else least(3600,30*power(2,least(attempts,7))::integer) end)
     where key=p_key and token=p_token and lease_until>clock_timestamp();
    return found;
   end $fn$;
   alter table __SCHEMA__.notification_outbox add column if not exists lease_token uuid;
   alter table __SCHEMA__.notification_outbox add column if not exists lease_until timestamptz;
   alter table __SCHEMA__.notification_outbox add column if not exists next_attempt_at timestamptz not null default now();
   alter table __SCHEMA__.notification_outbox add column if not exists provider_id text;
   alter table __SCHEMA__.notification_outbox add column if not exists last_error text;
   create index if not exists outbox_due on __SCHEMA__.notification_outbox(next_attempt_at) where status='pending';
   create table if not exists __SCHEMA__.email_suppressions(email text primary key, reason text not null, created_at timestamptz not null default now());
   alter table __SCHEMA__.email_suppressions enable row level security;
   revoke all on __SCHEMA__.email_suppressions from anon,authenticated;
   revoke all on __SCHEMA__.notification_outbox from anon,authenticated;
   grant all on __SCHEMA__.email_suppressions to service_role;
   create or replace function __SCHEMA__.claim_notifications(p_limit integer default 10)
   returns setof __SCHEMA__.notification_outbox language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
   begin
    -- Never start sending an old backlog on activation. Provider idempotency expires after 24h.
    update __SCHEMA__.notification_outbox set status='review',lease_token=null,lease_until=null,last_error='Event expired before delivery'
     where status='pending' and created_at<clock_timestamp()-interval '23 hours' and (lease_until is null or lease_until<=clock_timestamp());
    return query with due as (
     select id from __SCHEMA__.notification_outbox where status='pending' and next_attempt_at<=clock_timestamp()
      and (lease_until is null or lease_until<=clock_timestamp()) order by created_at,id for update skip locked limit least(20,greatest(1,p_limit))
    ) update __SCHEMA__.notification_outbox n set lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes',attempts=n.attempts+1
      from due where n.id=due.id returning n.*;
   end $fn$;
   create or replace function __SCHEMA__.finish_notification(p_id uuid,p_token uuid,p_provider_id text default null,p_error text default null,p_review boolean default false)
   returns boolean language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
   begin
    update __SCHEMA__.notification_outbox set status=case when p_review or (p_error is not null and attempts>=6) then 'review' when p_error is null then 'sent' else 'pending' end,
     provider_id=p_provider_id,last_error=p_error,lease_token=null,lease_until=null,
     next_attempt_at=clock_timestamp()+make_interval(secs=>least(3600,30*power(2,least(attempts,7))::integer))
     where id=p_id and lease_token=p_token and lease_until>clock_timestamp() and status='pending';
    return found;
   end $fn$;
   create or replace function __SCHEMA__.activate_slate_checked(p_expected uuid,p_next uuid)
   returns void language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
   begin
    perform pg_advisory_xact_lock(hashtextextended('__SCHEMA__.active-slate',0));
    if not exists(select 1 from __SCHEMA__.slates where id=p_expected and is_active and auto_assign_completed_at is not null) then raise exception 'Active day changed or assignments incomplete'; end if;
    if not exists(select 1 from __SCHEMA__.games where slate_id=p_expected)
      or exists(select 1 from __SCHEMA__.games where slate_id=p_expected and result='pending') then raise exception 'Results incomplete'; end if;
    if exists(select 1 from __SCHEMA__.picks pp join __SCHEMA__.players p on p.id=pp.player_id join __SCHEMA__.games g on g.slate_id=pp.slate_id
      where pp.slate_id=p_expected and p.status='alive' and not pp.loss_excused and
       ((pp.team=g.home_team and g.result in ('away_win','tie')) or (pp.team=g.away_team and g.result in ('home_win','tie')))) then raise exception 'Grading incomplete'; end if;
    if not exists(select 1 from __SCHEMA__.slates a join __SCHEMA__.slates b on b.id=p_next where a.id=p_expected and b.slate_date>a.slate_date and a.season_year=b.season_year) then raise exception 'Invalid next day'; end if;
    perform __SCHEMA__.activate_slate(p_next);
   end $fn$;

   alter table __SCHEMA__.slates add column if not exists result_checked_at timestamptz;
   alter table __SCHEMA__.slates add column if not exists assignment_token uuid;
   alter table __SCHEMA__.slates add column if not exists assignment_rankings jsonb;
   create or replace function __SCHEMA__.begin_assignment(p_slate_id uuid)
   returns uuid language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
   declare token uuid;
   begin
    update __SCHEMA__.slates set assignment_token=gen_random_uuid(),auto_assign_claimed_at=clock_timestamp()
     where id=p_slate_id and is_active and auto_assign_completed_at is null
      and (auto_assign_claimed_at is null or auto_assign_claimed_at<clock_timestamp()-interval '4 minutes') returning assignment_token into token;
    return token;
   end $fn$;
   create or replace function __SCHEMA__.apply_assignment(p_slate_id uuid,p_token uuid,p_player_id uuid,p_teams jsonb,p_reason text default null,p_period_ids uuid[] default null,p_expected_count integer default 0)
   returns void language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
   declare s __SCHEMA__.slates%rowtype; t jsonb;
   begin
    select * into s from __SCHEMA__.slates where id=p_slate_id for update;
    if not found or not s.is_active or s.assignment_token is distinct from p_token or s.auto_assign_claimed_at<clock_timestamp()-interval '4 minutes' then raise exception 'Assignment lease lost'; end if;
    -- Recheck the expected quota state under the same player lock as manual writes.
    perform 1 from __SCHEMA__.players where id=p_player_id for update;
    if (select count(*) from __SCHEMA__.picks where player_id=p_player_id and slate_id=any(coalesce(p_period_ids,array[p_slate_id])))<>p_expected_count then raise exception 'Pick state changed; retry'; end if;
    if p_reason is not null then
     update __SCHEMA__.players set status='eliminated',elimination_slate=s.slate_number,elimination_reason=p_reason where id=p_player_id and status='alive';
    else
     for t in select value from jsonb_array_elements(p_teams) loop
      insert into __SCHEMA__.picks(player_id,slate_id,team,seed,auto_assigned,submitted_by_admin)
       values(p_player_id,p_slate_id,t->>'team',(t->>'seed')::integer,true,false);
     end loop;
    end if;
   end $fn$;
   create or replace function __SCHEMA__.finish_assignment(p_slate_id uuid,p_token uuid,p_done boolean)
   returns boolean language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
   begin
    update __SCHEMA__.slates set auto_assign_completed_at=case when p_done then clock_timestamp() else null end,
     auto_assign_claimed_at=null,assignment_token=null where id=p_slate_id and assignment_token=p_token and auto_assign_claimed_at>clock_timestamp()-interval '4 minutes';
    return found;
   end $fn$;
   create or replace function __SCHEMA__.operation_retention(p_apply boolean default false)
   returns jsonb language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
   declare notifications bigint; jobs bigint; sessions bigint;
   begin
    select count(*) into notifications from __SCHEMA__.notification_outbox where created_at<now()-interval '30 days' and status in ('sent','review') and payload<>'{}'::jsonb;
    select count(*) into jobs from __SCHEMA__.operation_runs where updated_at<now()-interval '30 days' and status='done';
    select count(*) into sessions from __SCHEMA__.revoked_sessions where expires_at<now()-interval '7 days';
    if p_apply then
     update __SCHEMA__.notification_outbox set payload='{}'::jsonb,last_error=null where created_at<now()-interval '30 days' and status in ('sent','review');
     delete from __SCHEMA__.operation_runs where updated_at<now()-interval '30 days' and status='done';
     delete from __SCHEMA__.revoked_sessions where expires_at<now()-interval '7 days';
     insert into __SCHEMA__.audit_log(event_type,actor,message,details) values('retention-applied','system','Expired operational records cleaned',jsonb_build_object('notification_payloads',notifications,'jobs',jobs,'sessions',sessions));
    end if;
    return jsonb_build_object('applied',p_apply,'notification_payloads',notifications,'jobs',jobs,'sessions',sessions);
   end $fn$;
    create or replace function __SCHEMA__.queue_pick_reminders(p_slate_id uuid, p_player_ids uuid[], p_period_ids uuid[],
      p_quota integer, p_deadline timestamptz, p_deadline_label text, p_window text)
    returns integer language plpgsql set search_path = __SCHEMA__, pg_catalog as $fn$
    declare n integer; effective_now timestamptz := clock_timestamp(); actual_deadline timestamptz;
    begin
      if '__SCHEMA__' = 'sandbox' and to_regclass('sandbox.clock') is not null then
        execute 'select coalesce(simulated_now, clock_timestamp()) from sandbox.clock where id = true' into effective_now;
      end if;
      select least(s.locks_at, (select min(tip_time) from __SCHEMA__.games where slate_id = s.id and not time_tbd))
        into actual_deadline from __SCHEMA__.slates s where s.id = p_slate_id and s.is_active;
      if actual_deadline is null then return 0; end if;
      actual_deadline := least(actual_deadline, p_deadline);
      if actual_deadline is null or actual_deadline <= effective_now or actual_deadline > effective_now + interval '24 hours' then return 0; end if;
      insert into __SCHEMA__.notification_outbox(event_key, kind, payload)
      select 'reminder:' || p_slate_id || ':' || p.id || ':' || p_window, 'reminder',
        jsonb_build_object('player_id', p.id, 'email', p.email, 'name', p.full_name, 'slate_id', p_slate_id,
          'deadline', actual_deadline, 'deadline_label', p_deadline_label)
      from __SCHEMA__.players p where p.id = any(p_player_ids) and p.status = 'alive' and p.notifications_enabled
        and (select count(*) from __SCHEMA__.picks where player_id = p.id and slate_id = any(p_period_ids)) < p_quota
      on conflict(event_key) do nothing;
      get diagnostics n = row_count; return n;
    end $fn$;
    revoke all on function __SCHEMA__.queue_pick_reminders(uuid, uuid[], uuid[], integer, timestamptz, text, text) from public, anon, authenticated;
    grant execute on function __SCHEMA__.queue_pick_reminders(uuid, uuid[], uuid[], integer, timestamptz, text, text) to service_role;


   -- Atomic, consistent application backup. Includes sensitive authentication data; admin only.
   create or replace function __SCHEMA__.contest_backup()
   returns jsonb language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
   declare backup_tables text[]:=array['teams','pools','slates','players','games','picks','audit_log','notification_outbox','contest_archives','revoked_sessions','operation_runs','email_suppressions'];
    t text; rows jsonb; result jsonb:='{}'::jsonb; columns jsonb:='{}'::jsonb; definition jsonb;
   begin
    foreach t in array array['rate_limits','clock','player_accounts','notification_preferences','push_devices'] loop
      if to_regclass(format('%I.%I','__SCHEMA__',t)) is not null then backup_tables:=array_append(backup_tables,t); end if;
    end loop;
    if exists(select 1 from information_schema.tables where table_schema='__SCHEMA__' and table_type='BASE TABLE' and table_name<>all(backup_tables)) then
      raise exception 'Unrecognized application table; extend backup coverage before continuing';
    end if;
    -- A share lock gives all table reads the same stable application state.
    foreach t in array backup_tables loop execute format('lock table %I.%I in share mode','__SCHEMA__',t); end loop;
    foreach t in array backup_tables loop
     execute format('select coalesce(jsonb_agg(to_jsonb(r)),''[]''::jsonb) from %I.%I r','__SCHEMA__',t) into rows;
     result:=result||jsonb_build_object(t,rows);
     select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod)) order by a.attnum)
       into definition from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='__SCHEMA__' and c.relname=t and a.attnum>0 and not a.attisdropped;
     columns:=columns||jsonb_build_object(t,definition);
    end loop;
    return jsonb_build_object('version',2,'schema','__SCHEMA__','created_at',clock_timestamp(),'tables',result,'columns',columns);
   end $fn$;
  $schema$;
  execute replace(ddl,'__SCHEMA__',target);
  -- Restrict every new entry point, including default function EXECUTE grants.
  foreach ddl in array array['claim_operation(text,integer)','finish_operation(text,uuid,boolean,text)','claim_notifications(integer)',
   'finish_notification(uuid,uuid,text,text,boolean)','activate_slate_checked(uuid,uuid)','contest_backup()',
   'begin_assignment(uuid)','apply_assignment(uuid,uuid,uuid,jsonb,text,uuid[],integer)','finish_assignment(uuid,uuid,boolean)','operation_retention(boolean)'] loop
   execute format('revoke all on function %I.%s from public,anon,authenticated',target,ddl);
   execute format('grant execute on function %I.%s to service_role',target,ddl);
  end loop;
 end loop;
end $migration$;
notify pgrst,'reload schema';
commit;
