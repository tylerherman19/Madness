begin;
do $migration$
declare target text; ddl text;
begin
foreach target in array array['public','sandbox'] loop
 ddl:=$schema$
create or replace function __SCHEMA__.active_pick_requirement() returns jsonb language plpgsql stable set search_path=__SCHEMA__,pg_catalog as $fn$
declare s __SCHEMA__.slates%rowtype; cfg __SCHEMA__.pools%rowtype; round_name text; quota integer:=1; ids uuid[];
begin
 select * into s from __SCHEMA__.slates where is_active;
 if not found then return null; end if;
 select * into cfg from __SCHEMA__.pools where is_active;
 select __SCHEMA__.canonical_round(round_label) into round_name from __SCHEMA__.games where slate_id=s.id order by id limit 1;
 ids:=array[s.id];
 if cfg.competition_mode='march-madness' and (cfg.pick_frequency='tournament-round' or round_name='Elite 8') then
 quota:=case when round_name in ('1st Round','2nd Round','Sweet 16','Elite 8') then 2 else 1 end;
 select array_agg(distinct ss.id) into ids from __SCHEMA__.slates ss join __SCHEMA__.games g on g.slate_id=ss.id where ss.season_year=s.season_year and (cfg.starts_on is null or ss.slate_date>=cfg.starts_on) and __SCHEMA__.canonical_round(g.round_label)=round_name;
 end if;
 return jsonb_build_object('slate_id',s.id,'slate_number',s.slate_number,'season',s.season_year,'period_ids',ids,'quota',quota,'deadline',least(s.locks_at,(select min(tip_time) from __SCHEMA__.games where slate_id=s.id and not time_tbd)));
end $fn$;
create or replace function __SCHEMA__.can_pick_early(p_player uuid,p_target uuid) returns boolean language plpgsql stable set search_path=__SCHEMA__,pg_catalog as $fn$
declare active __SCHEMA__.slates%rowtype; target __SCHEMA__.slates%rowtype; ids uuid[]; requirement jsonb; n integer; quota integer; target_round text; current_round text;
begin
 select * into active from __SCHEMA__.slates where is_active;
 select * into target from __SCHEMA__.slates where id=p_target;
 if active.id is null or target.id is null or active.season_year<>target.season_year or target.slate_date<=active.slate_date or target.slate_date>active.slate_date+10 then return false; end if;
 if target.slate_date<>(select min(s.slate_date) from __SCHEMA__.slates s where s.season_year=active.season_year and s.slate_date>active.slate_date and exists(select 1 from __SCHEMA__.games where slate_id=s.id)) then return false; end if;
 requirement:=__SCHEMA__.active_pick_requirement();
 if (requirement->>'deadline')::timestamptz is null or (requirement->>'deadline')::timestamptz>clock_timestamp() then return false; end if;
 select array_agg(value::uuid) into ids from jsonb_array_elements_text(requirement->'period_ids');
 select count(*) into n from __SCHEMA__.picks p join __SCHEMA__.slates ss on ss.id=p.slate_id where p.player_id=p_player and p.slate_id=any(ids) and ss.slate_date<=active.slate_date;
 if n=0 then return false; end if;
 if exists(select 1 from __SCHEMA__.picks p join __SCHEMA__.slates ss on ss.id=p.slate_id where p.player_id=p_player and p.slate_id=any(ids) and ss.slate_date<=active.slate_date and not p.loss_excused and not exists(select 1 from __SCHEMA__.games g where g.slate_id=p.slate_id and ((p.team=g.home_team and g.result='home_win')or(p.team=g.away_team and g.result='away_win')))) then return false; end if;
 select __SCHEMA__.canonical_round(round_label) into target_round from __SCHEMA__.games where slate_id=target.id limit 1;
 select __SCHEMA__.canonical_round(round_label) into current_round from __SCHEMA__.games where slate_id=active.id limit 1;
 quota:=(requirement->>'quota')::integer;
 if quota>1 and target_round is distinct from current_round and n<quota then return false; end if;
 return true;
end $fn$;
create or replace function __SCHEMA__.contest_counts() returns jsonb language plpgsql stable set search_path=__SCHEMA__,pg_catalog as $fn$
declare requirement jsonb; ids uuid[]; quota integer; result jsonb;
begin
 requirement:=__SCHEMA__.active_pick_requirement();
 select array_agg(value::uuid) into ids from jsonb_array_elements_text(requirement->'period_ids');
 quota:=(requirement->>'quota')::integer;
 select jsonb_build_object('players',count(*),'alive',count(*) filter(where p.status='alive'),'eliminated',count(*) filter(where p.status='eliminated'),'paid',count(*) filter(where p.paid),'unpaid',count(*) filter(where not p.paid),
 'complete',count(*) filter(where p.status='alive' and coalesce(n,0)>=quota),'partial',count(*) filter(where p.status='alive' and n>0 and n<quota),'missing',count(*) filter(where p.status='alive' and coalesce(n,0)=0),
 'unpicked',count(*) filter(where p.status='alive' and coalesce(n,0)<quota)) into result
 from __SCHEMA__.players p left join(select player_id,count(*) n from __SCHEMA__.picks where slate_id=any(ids) group by player_id) counts on counts.player_id=p.id;
 return result||jsonb_build_object('requirement',requirement);
end $fn$;
create or replace function __SCHEMA__.request_password_reset(p_player uuid,p_hash text,p_expires timestamptz,p_encrypted jsonb,p_actor text) returns uuid language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
declare p __SCHEMA__.players%rowtype; nid uuid;
begin
 select * into p from __SCHEMA__.players where id=p_player for update;
 if not found or p_expires<=clock_timestamp() or not(p_encrypted ? 'sealed') then raise exception 'Invalid restricted recovery request'; end if;
 update __SCHEMA__.players set pin_reset_token=p_hash,pin_reset_expires=p_expires where id=p_player;
 update __SCHEMA__.notification_outbox set status='canceled',last_error='Superseded reset request' where player_id=p_player and kind='password-reset' and status in ('held','pending');
 insert into __SCHEMA__.notification_outbox(event_key,kind,player_id,recipient,payload,priority,expires_at)
 values('reset:'||gen_random_uuid(),'password-reset',p.id,p.email,jsonb_build_object('request',p_encrypted,'reset_expires',p_expires),0,p_expires-interval '1 minute') returning id into nid;
 insert into __SCHEMA__.audit_log(event_type,actor,player_id,message,details) values('password-reset-requested','admin',p.id,'Restricted password reset queued',jsonb_build_object('actor',p_actor,'notification_id',nid));
 return nid;
end $fn$;
create or replace function __SCHEMA__.record_incident(p_key text,p_impact text,p_correlation uuid,p_detail text) returns void language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
begin
 insert into __SCHEMA__.incidents(key,impact,correlation_id,details) values(p_key,p_impact,p_correlation,left(p_detail,1000)) on conflict(key) do update set latest_at=clock_timestamp(),occurrences=__SCHEMA__.incidents.occurrences+1,impact=excluded.impact,correlation_id=excluded.correlation_id,details=excluded.details,status='open';
end $fn$;
create or replace function __SCHEMA__.reconcile_contest() returns jsonb language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
declare result jsonb; counts jsonb; missing_receipts bigint; ungraded bigint; expired_leases bigint; active_days bigint; missing_audience bigint; cfg __SCHEMA__.pools%rowtype;
begin
 counts:=__SCHEMA__.contest_counts();
 select * into cfg from __SCHEMA__.pools where is_active;
 select count(*) into missing_receipts from __SCHEMA__.pick_revisions r where not exists(select 1 from __SCHEMA__.notification_outbox n where n.event_key='pick:'||r.pick_id||':'||r.version);
 select count(distinct p.id) into ungraded from __SCHEMA__.picks p join __SCHEMA__.players e on e.id=p.player_id join __SCHEMA__.games g on g.slate_id=p.slate_id where e.status='alive' and not p.loss_excused and ((p.team=g.home_team and g.result in ('away_win','tie')) or(p.team=g.away_team and g.result in ('home_win','tie')));
 select count(*) into expired_leases from __SCHEMA__.operation_runs where status='running' and lease_until<clock_timestamp();
 expired_leases:=expired_leases+(select count(*) from __SCHEMA__.notification_outbox where status='processing' and lease_until<clock_timestamp());
 select count(*) into active_days from __SCHEMA__.slates where is_active;
 select count(*) into missing_audience from __SCHEMA__.campaign_recipients r left join __SCHEMA__.notification_outbox n on n.id=r.notification_id where n.id is null;
 result:=jsonb_build_object('counts',counts,'missing_notification_intents',missing_receipts,'ungraded_losing_picks',ungraded,'abandoned_leases',expired_leases,'active_period_count',active_days,'campaign_recipient_gaps',missing_audience,
 'review_messages',(select count(*) from __SCHEMA__.notification_outbox where status='review'),
 'oldest_eligible_message',(select min(created_at) from __SCHEMA__.notification_outbox where status='pending' and next_attempt_at<=clock_timestamp() and expires_at>clock_timestamp()),
 'undocumented_overrides',(select count(*) from __SCHEMA__.pick_revisions where origin='administrator' and nullif(btrim(reason),'') is null),
 'cross_season_picks',(select count(*) from __SCHEMA__.picks p join __SCHEMA__.slates s on s.id=p.slate_id where s.season_year<>cfg.season_year),
 'missing_after_lock',case when (counts->'requirement'->>'deadline')::timestamptz<=clock_timestamp() then counts->'unpicked' else '0'::jsonb end);
 insert into __SCHEMA__.integrity_checks(findings) values(result);
 return result;
end $fn$;
create or replace function __SCHEMA__.retry_operation(p_key text,p_actor text,p_reason text) returns boolean language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
begin
 if length(btrim(p_reason))<3 then raise exception 'Reason required'; end if;
 update __SCHEMA__.operation_runs set status='pending',attempts=0,token=null,lease_until=null,next_attempt_at=clock_timestamp() where key=p_key and status='review' and (lease_until is null or lease_until<clock_timestamp());
 if not found then return false; end if;
 insert into __SCHEMA__.audit_log(event_type,actor,message,details) values('operation-retried','admin','Reviewed job retry requested',jsonb_build_object('job',p_key,'actor',p_actor,'reason',p_reason));
 return true;
end $fn$;
create or replace function __SCHEMA__.retry_notification(p_id uuid,p_actor text,p_reason text) returns boolean language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
begin
 if length(btrim(p_reason))<3 then raise exception 'Reason required'; end if;
 update __SCHEMA__.notification_outbox set status='pending',next_attempt_at=clock_timestamp(),last_error=null where id=p_id and status='review' and provider_id is null and expires_at>clock_timestamp() and (first_attempt_at is null or first_attempt_at>clock_timestamp()-interval '23 hours') and (lease_until is null or lease_until<clock_timestamp()) and created_at>=(select activation_at from __SCHEMA__.delivery_settings where id=true);
 if not found then return false; end if;
 insert into __SCHEMA__.audit_log(event_type,actor,message,details) values('operation-retried','admin','Reviewed notification retry requested',jsonb_build_object('notification',p_id,'actor',p_actor,'reason',p_reason));
 return true;
end $fn$;
-- Terminal championship waits for assignments, finals and grading, then stops advancing.
create or replace function __SCHEMA__.complete_tournament(p_slate uuid) returns boolean language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
begin
 perform pg_advisory_xact_lock(hashtextextended('__SCHEMA__.active-slate',0));
 if not exists(select 1 from __SCHEMA__.slates s join __SCHEMA__.games g on g.slate_id=s.id where s.id=p_slate and s.is_active and s.auto_assign_completed_at is not null and __SCHEMA__.canonical_round(g.round_label)='National Championship') then return false; end if;
 if exists(select 1 from __SCHEMA__.games where slate_id=p_slate and result='pending') or exists(select 1 from __SCHEMA__.picks p join __SCHEMA__.players e on e.id=p.player_id join __SCHEMA__.games g on g.slate_id=p.slate_id where p.slate_id=p_slate and not p.loss_excused and e.status='alive' and ((p.team=g.home_team and g.result in ('away_win','tie'))or(p.team=g.away_team and g.result in ('home_win','tie')))) then return false; end if;
 update __SCHEMA__.pools set status='completed' where is_active and competition_mode='march-madness';
 update __SCHEMA__.slates set is_active=false where id=p_slate;
 insert into __SCHEMA__.audit_log(event_type,actor,message,details) values('tournament-completed','system','Championship grading complete',jsonb_build_object('slate',p_slate));
 return true;
end $fn$;

create or replace function __SCHEMA__.finish_recurring_operation(p_key text,p_token uuid,p_interval integer,p_progress jsonb) returns boolean language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
begin
 update __SCHEMA__.operation_runs set status='pending',attempts=0,token=null,lease_until=null,next_attempt_at=clock_timestamp()+make_interval(secs=>greatest(1,p_interval)),last_success_at=clock_timestamp(),updated_at=clock_timestamp(),last_error=null,progress=p_progress where key=p_key and token=p_token and lease_until>clock_timestamp();
 return found;
end $fn$;
$schema$;
execute replace(ddl,'__SCHEMA__',target);
for ddl in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=target and p.proname=any(array['active_pick_requirement','can_pick_early','contest_counts','request_password_reset','record_incident','reconcile_contest','retry_notification','retry_operation','complete_tournament','finish_recurring_operation']) loop
 execute 'revoke all on function '||ddl||' from public,anon,authenticated';execute 'grant execute on function '||ddl||' to service_role';
end loop;
end loop;
end $migration$;
notify pgrst,'reload schema';
commit;
