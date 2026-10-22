begin;
do $migration$
declare target text;ddl text;
begin
foreach target in array array['public','sandbox'] loop
 ddl:=$schema$
alter table __SCHEMA__.games add column if not exists graded_at timestamptz;
alter table __SCHEMA__.games add column if not exists result_version integer not null default 1;
create or replace function __SCHEMA__.mark_results_graded(p_games jsonb) returns integer language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
declare n integer;
begin
 update __SCHEMA__.games g set graded_at=clock_timestamp() from jsonb_to_recordset(p_games) as expected(id uuid,result text) where g.id=expected.id and g.result=expected.result and g.result<>'pending' and not exists(select 1 from __SCHEMA__.picks p join __SCHEMA__.players e on e.id=p.player_id where p.slate_id=g.slate_id and e.status='alive' and not p.loss_excused and ((p.team=g.home_team and g.result in ('away_win','tie'))or(p.team=g.away_team and g.result in ('home_win','tie'))));
 get diagnostics n=row_count;return n;
end $fn$;
create or replace function __SCHEMA__.audit_result_correction() returns trigger language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
begin
 if new.result<>old.result then new.graded_at:=null;new.result_version:=old.result_version+1;end if;
 if old.result<>'pending' and new.result<>old.result then
 insert into __SCHEMA__.audit_log(event_type,actor,message,details) values('result-corrected','system','Previously final result changed; eligibility review required',jsonb_build_object('game_id',new.id,'slate_id',new.slate_id,'previous',old.result,'new',new.result));
 perform __SCHEMA__.record_incident('result-correction:'||new.id,'A final result changed. Review earlier eliminations, later eligibility, standings and messages before correcting entries.',gen_random_uuid(),'game_id='||new.id||'; slate_id='||new.slate_id);
 end if;
 return new;
end $fn$;
drop trigger if exists games_result_corrections on __SCHEMA__.games;
create trigger games_result_corrections before update of result on __SCHEMA__.games for each row execute function __SCHEMA__.audit_result_correction();
create or replace function __SCHEMA__.delivery_retention() returns jsonb language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
declare sensitive_count integer; general_count integer;
begin
 update __SCHEMA__.notification_outbox set payload='{}',frozen_request=null where kind='password-reset' and expires_at<clock_timestamp()-interval '1 day' and (lease_until is null or lease_until<clock_timestamp()) and (payload<>'{}' or frozen_request is not null);
 get diagnostics sensitive_count=row_count;
 update __SCHEMA__.notification_outbox set payload='{}',frozen_request=null,recipient=null where created_at<clock_timestamp()-interval '30 days' and status in ('held','sent','review','expired','suppressed','canceled') and (payload<>'{}' or frozen_request is not null or recipient is not null);
 get diagnostics general_count=row_count;
 delete from __SCHEMA__.notification_attempts where started_at<clock_timestamp()-interval '90 days';
 delete from __SCHEMA__.provider_events where received_at<clock_timestamp()-interval '90 days';
 delete from __SCHEMA__.integrity_checks where observed_at<clock_timestamp()-interval '90 days';
 return jsonb_build_object('restricted_payloads',sensitive_count,'general_payloads',general_count);
end $fn$;
$schema$;
 execute replace(ddl,'__SCHEMA__',target);
 execute format('revoke all on function %I.mark_results_graded(jsonb) from public,anon,authenticated',target);
 execute format('grant execute on function %I.mark_results_graded(jsonb) to service_role',target);
 execute format('revoke all on function %I.audit_result_correction() from public,anon,authenticated',target);
 execute format('revoke all on function %I.delivery_retention() from public,anon,authenticated',target);
 execute format('grant execute on function %I.delivery_retention() to service_role',target);
end loop;
end $migration$;
commit;
