-- Result resolution. Additive and idempotent.
--  * admin-entered results outrank ESPN (games.result_source/result_note, guarded by a trigger)
--  * a game can be voided: result 'void' = resolved with no loser, its picks survive
--  * grading becomes a recomputation (regrade_slate) that can also undo a grading elimination
--  * contest_state() reports registered/alive/started/stopped; no winner is ever recorded
begin;
do $migration$
declare target text; ddl text; con text;
begin
 foreach target in array array['public','sandbox'] loop
  if to_regclass(format('%I.games',target)) is null or to_regclass(format('%I.players',target)) is null then continue; end if;
  -- 'void' joins the allowed results (the constraint is unnamed in older migrations).
  for con in select c.conname from pg_constraint c where c.conrelid=format('%I.games',target)::regclass
   and c.contype='c' and pg_get_constraintdef(c.oid) like '%home_win%' loop
   execute format('alter table %I.games drop constraint %I',target,con);
  end loop;
  execute format('alter table %I.games add constraint games_result_check check (result in (''home_win'',''away_win'',''tie'',''pending'',''void''))',target);
  ddl:=$schema$
alter table __SCHEMA__.games add column if not exists result_source text not null default 'espn';
alter table __SCHEMA__.games add column if not exists result_note text;
alter table __SCHEMA__.games add column if not exists void_excused_picks uuid[];
alter table __SCHEMA__.players add column if not exists elimination_source text;
alter table __SCHEMA__.games drop constraint if exists games_result_source_check;
alter table __SCHEMA__.games add constraint games_result_source_check check (result_source in ('espn','admin'));
-- Existing eliminations written by grading carry the standard reason text; everything else stays manual.
update __SCHEMA__.players set elimination_source='grading'
 where status='eliminated' and elimination_source is null and elimination_reason ~ '^Slate [0-9]+: picked .+ (lost|game ended in a tie)$';

create or replace function __SCHEMA__.contest_now() returns timestamptz language plpgsql stable set search_path=__SCHEMA__,pg_catalog as $fn$
declare t timestamptz:=clock_timestamp();
begin
 if '__SCHEMA__'='sandbox' and to_regclass('sandbox.clock') is not null then
  execute 'select coalesce(simulated_now, clock_timestamp()) from sandbox.clock where id = true' into t;
 end if;
 return t;
end $fn$;

-- Alive entries are always cleared of the grading marker, so a later manual elimination can never look automatic.
create or replace function __SCHEMA__.clear_elimination_source() returns trigger language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
begin
 if new.status='alive' then new.elimination_source:=null; end if;
 return new;
end $fn$;
drop trigger if exists players_00_elimination_source on __SCHEMA__.players;
create trigger players_00_elimination_source before update on __SCHEMA__.players for each row execute function __SCHEMA__.clear_elimination_source();

-- ESPN (any write that is not an administrator operation) can never change a manual result.
create or replace function __SCHEMA__.guard_manual_result() returns trigger language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
begin
 if old.result_source='admin' and coalesce(current_setting('madness.admin_result',true),'')<>'on' then
  new.result:=old.result; new.result_source:=old.result_source; new.result_note:=old.result_note;
 end if;
 return new;
end $fn$;
drop trigger if exists games_01_result_guard on __SCHEMA__.games;
create trigger games_01_result_guard before update on __SCHEMA__.games for each row execute function __SCHEMA__.guard_manual_result();

create or replace function __SCHEMA__.entry_has_loss(p_player uuid) returns boolean language sql stable set search_path=__SCHEMA__,pg_catalog as $fn$
 select exists(select 1 from __SCHEMA__.picks pp join __SCHEMA__.games g on g.slate_id=pp.slate_id and pp.team in(g.home_team,g.away_team)
  where pp.player_id=p_player and not pp.loss_excused and
  ((pp.team=g.home_team and g.result in('away_win','tie')) or (pp.team=g.away_team and g.result in('home_win','tie'))))
$fn$;

create or replace function __SCHEMA__.later_slate_locked(p_slate uuid) returns boolean language sql stable set search_path=__SCHEMA__,pg_catalog as $fn$
 select exists(select 1 from __SCHEMA__.slates s join __SCHEMA__.slates l on l.season_year=s.season_year and l.slate_date>s.slate_date
  where s.id=p_slate and least(l.locks_at,(select min(tip_time) from __SCHEMA__.games where slate_id=l.id and not time_tbd))<=__SCHEMA__.contest_now())
$fn$;

create or replace function __SCHEMA__.admin_set_result(p_game uuid,p_result text,p_reason text,p_session text default null) returns jsonb language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
declare g __SCHEMA__.games%rowtype; note text:=btrim(coalesce(p_reason,'')); changed boolean;
begin
 if length(note)<3 then raise exception 'A reason is required'; end if;
 if p_result is null or p_result not in('home_win','away_win','tie','pending') then raise exception 'Invalid result'; end if;
 select * into g from __SCHEMA__.games where id=p_game for update;
 if not found then raise exception 'Game not found'; end if;
 if g.result='void' then raise exception 'This game is voided; undo the void first'; end if;
 perform set_config('madness.admin_result','on',true);
 if p_result='pending' then
  changed:=g.result<>'pending' or g.result_source<>'espn';
  update __SCHEMA__.games set result='pending',result_source='espn',result_note=null where id=p_game;
 else
  changed:=g.result<>p_result or g.result_source<>'admin' or g.result_note is distinct from note;
  if changed then update __SCHEMA__.games set result=p_result,result_source='admin',result_note=note where id=p_game; end if;
 end if;
 return jsonb_build_object('changed',changed,'previous',g.result,'previous_source',g.result_source,'slate_id',g.slate_id,'home_team',g.home_team,'away_team',g.away_team);
end $fn$;

create or replace function __SCHEMA__.release_result(p_game uuid,p_reason text,p_session text default null) returns jsonb language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
declare g __SCHEMA__.games%rowtype;
begin
 if length(btrim(coalesce(p_reason,'')))<3 then raise exception 'A reason is required'; end if;
 select * into g from __SCHEMA__.games where id=p_game for update;
 if not found then raise exception 'Game not found'; end if;
 if g.result='void' then raise exception 'This game is voided; undo the void instead'; end if;
 if g.result_source<>'admin' then return jsonb_build_object('changed',false,'slate_id',g.slate_id,'home_team',g.home_team,'away_team',g.away_team); end if;
 perform set_config('madness.admin_result','on',true);
 update __SCHEMA__.games set result_source='espn',result_note=null where id=p_game;
 return jsonb_build_object('changed',true,'previous',g.result,'slate_id',g.slate_id,'home_team',g.home_team,'away_team',g.away_team);
end $fn$;

create or replace function __SCHEMA__.void_game(p_game uuid,p_reason text,p_session text default null) returns jsonb language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
declare g __SCHEMA__.games%rowtype; s __SCHEMA__.slates%rowtype; excused uuid[]; note text:=btrim(coalesce(p_reason,''));
begin
 if length(note)<3 then raise exception 'A reason is required'; end if;
 select * into g from __SCHEMA__.games where id=p_game for update;
 if not found then raise exception 'Game not found'; end if;
 select * into s from __SCHEMA__.slates where id=g.slate_id;
 if g.result='void' then return jsonb_build_object('changed',false,'slate_id',g.slate_id,'home_team',g.home_team,'away_team',g.away_team); end if;
 if g.result<>'pending' and not s.is_active then raise exception 'Only a pending game, or a game on the active day, can be voided'; end if;
 perform set_config('madness.admin_result','on',true);
 -- Picks on either team survive; the team stays used (the pick row is untouched).
 with changed as (update __SCHEMA__.picks set loss_excused=true where slate_id=g.slate_id and team in(g.home_team,g.away_team) and not loss_excused returning id)
  select array_agg(id) into excused from changed;
 update __SCHEMA__.games set result='void',result_source='admin',result_note=note,void_excused_picks=excused where id=p_game;
 return jsonb_build_object('changed',true,'previous',g.result,'slate_id',g.slate_id,'home_team',g.home_team,'away_team',g.away_team,'excused',coalesce(cardinality(excused),0));
end $fn$;

create or replace function __SCHEMA__.unvoid_game(p_game uuid,p_reason text,p_session text default null) returns jsonb language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
declare g __SCHEMA__.games%rowtype; s __SCHEMA__.slates%rowtype;
begin
 if length(btrim(coalesce(p_reason,'')))<3 then raise exception 'A reason is required'; end if;
 select * into g from __SCHEMA__.games where id=p_game for update;
 if not found then raise exception 'Game not found'; end if;
 select * into s from __SCHEMA__.slates where id=g.slate_id;
 if g.result<>'void' then return jsonb_build_object('changed',false,'slate_id',g.slate_id,'home_team',g.home_team,'away_team',g.away_team); end if;
 if not s.is_active then raise exception 'The day has already advanced; a void can no longer be undone'; end if;
 perform set_config('madness.admin_result','on',true);
 -- Only the picks this void excused are un-excused; earlier administrator restorations stay.
 update __SCHEMA__.picks set loss_excused=false where id=any(coalesce(g.void_excused_picks,'{}'::uuid[]));
 update __SCHEMA__.games set result='pending',result_source='espn',result_note=null,void_excused_picks=null where id=p_game;
 return jsonb_build_object('changed',true,'slate_id',g.slate_id,'home_team',g.home_team,'away_team',g.away_team);
end $fn$;

create or replace function __SCHEMA__.pick_impact(p_game uuid) returns jsonb language plpgsql stable set search_path=__SCHEMA__,pg_catalog as $fn$
declare g __SCHEMA__.games%rowtype;
begin
 select * into g from __SCHEMA__.games where id=p_game;
 if not found then raise exception 'Game not found'; end if;
 return jsonb_build_object('game_id',g.id,'result',g.result,'result_source',g.result_source,'slate_id',g.slate_id,
  'home',jsonb_build_object('team',g.home_team,
   'picks',(select count(*) from __SCHEMA__.picks where slate_id=g.slate_id and team=g.home_team),
   'alive',(select count(*) from __SCHEMA__.picks pp join __SCHEMA__.players e on e.id=pp.player_id where pp.slate_id=g.slate_id and pp.team=g.home_team and e.status='alive')),
  'away',jsonb_build_object('team',g.away_team,
   'picks',(select count(*) from __SCHEMA__.picks where slate_id=g.slate_id and team=g.away_team),
   'alive',(select count(*) from __SCHEMA__.picks pp join __SCHEMA__.players e on e.id=pp.player_id where pp.slate_id=g.slate_id and pp.team=g.away_team and e.status='alive')));
end $fn$;

-- Recompute a slate from current results. Eliminates entries with an unexcused loss, restores entries that
-- grading itself eliminated here and no longer lose (only while no later day has locked), and lists the rest.
create or replace function __SCHEMA__.regrade_slate(p_slate uuid,p_games uuid[] default null) returns jsonb language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
declare s __SCHEMA__.slates%rowtype; r record; pl __SCHEMA__.players%rowtype; lp record; later boolean;
 eliminated jsonb:='[]'::jsonb; restored jsonb:='[]'::jsonb; manual jsonb:='[]'::jsonb;
begin
 select * into s from __SCHEMA__.slates where id=p_slate;
 if not found then return null; end if;
 later:=__SCHEMA__.later_slate_locked(p_slate);
 -- Picks on a voided game always survive (covers a pick added after the void).
 with changed as (update __SCHEMA__.picks pp set loss_excused=true from __SCHEMA__.games g
   where pp.slate_id=p_slate and g.slate_id=p_slate and g.result='void' and pp.team in(g.home_team,g.away_team) and not pp.loss_excused returning pp.id,g.id as gid),
  grouped as (select gid,array_agg(id) ids from changed group by gid)
 update __SCHEMA__.games g set void_excused_picks=coalesce(g.void_excused_picks,'{}'::uuid[])||grouped.ids from grouped where g.id=grouped.gid;
 for r in select distinct player_id from __SCHEMA__.picks where slate_id=p_slate order by player_id loop
  select * into pl from __SCHEMA__.players where id=r.player_id for update;
  select pp.id as pick_id,pp.team,g.result into lp from __SCHEMA__.picks pp join __SCHEMA__.games g on g.slate_id=pp.slate_id and pp.team in(g.home_team,g.away_team)
   where pp.player_id=pl.id and pp.slate_id=p_slate and not pp.loss_excused and (p_games is null or g.id=any(p_games)) and
   ((pp.team=g.home_team and g.result in('away_win','tie')) or (pp.team=g.away_team and g.result in('home_win','tie'))) order by pp.id limit 1;
  if found then
   if pl.status='alive' then
    update __SCHEMA__.players set status='eliminated',elimination_slate=s.slate_number,elimination_source='grading',
     elimination_reason='Slate '||s.slate_number||': picked '||lp.team||' — '||case when lp.result='tie' then 'game ended in a tie' else 'lost' end where id=pl.id;
    insert into __SCHEMA__.audit_log(event_type,actor,player_id,player_name,message,details)
     values('player-eliminated','system',pl.id,pl.full_name,pl.full_name||' eliminated — Slate '||s.slate_number||': picked '||lp.team||' — '||case when lp.result='tie' then 'game ended in a tie' else 'lost' end,
      jsonb_build_object('pick_id',lp.pick_id,'slate_number',s.slate_number,'team',lp.team));
    eliminated:=eliminated||to_jsonb(pl.full_name);
   end if;
  elsif pl.status='eliminated' and pl.elimination_source='grading' and pl.elimination_slate=s.slate_number and not __SCHEMA__.entry_has_loss(pl.id) then
   if later then
    insert into __SCHEMA__.incidents(key,impact,correlation_id,details)
     values('wrongly-eliminated:'||pl.id||':'||s.slate_number,'A corrected result means an entry eliminated by grading no longer lost, but a later day already locked. Restore the entry manually if appropriate.',gen_random_uuid(),'player_id='||pl.id||'; slate='||s.slate_number)
     on conflict(key) do update set status='open',latest_at=clock_timestamp() where __SCHEMA__.incidents.status<>'open';
    manual:=manual||to_jsonb(pl.full_name);
   else
    update __SCHEMA__.players set status='alive',elimination_reason=null,elimination_slate=null where id=pl.id;
    insert into __SCHEMA__.audit_log(event_type,actor,player_id,player_name,message,details)
     values('player-updated','system',pl.id,pl.full_name,'Result correction restored '||pl.full_name,
      jsonb_build_object('previous_status','eliminated','previous_reason',pl.elimination_reason,'previous_slate',pl.elimination_slate,'status','alive','reason','Corrected result: no losing pick remains'));
    update __SCHEMA__.notification_outbox set status='review' where kind='elimination' and payload->>'player_id'=pl.id::text and status in('pending','held');
    restored:=restored||to_jsonb(pl.full_name);
   end if;
  end if;
 end loop;
 update __SCHEMA__.games g set graded_at=clock_timestamp() where g.slate_id=p_slate and g.result<>'pending' and g.graded_at is null and (p_games is null or g.id=any(p_games))
  and not exists(select 1 from __SCHEMA__.picks p join __SCHEMA__.players e on e.id=p.player_id where p.slate_id=g.slate_id and e.status='alive' and not p.loss_excused
   and ((p.team=g.home_team and g.result in('away_win','tie')) or (p.team=g.away_team and g.result in('home_win','tie'))));
 return jsonb_build_object('eliminated',eliminated,'restored',restored,'manual',manual);
end $fn$;

create or replace function __SCHEMA__.contest_state() returns jsonb language plpgsql stable set search_path=__SCHEMA__,pg_catalog as $fn$
declare cfg __SCHEMA__.pools%rowtype; registered bigint; alive bigint; eliminated bigint; started boolean:=false; first_tip timestamptz;
begin
 select * into cfg from __SCHEMA__.pools where is_active;
 select count(*),count(*) filter(where status='alive'),count(*) filter(where status='eliminated') into registered,alive,eliminated from __SCHEMA__.players;
 if found and cfg.id is not null then
  if cfg.competition_mode='march-madness' then
   select exists(select 1 from __SCHEMA__.games g join __SCHEMA__.slates s on s.id=g.slate_id where s.season_year=cfg.season_year and __SCHEMA__.canonical_round(g.round_label)='1st Round')
    and not exists(select 1 from __SCHEMA__.games g join __SCHEMA__.slates s on s.id=g.slate_id where s.season_year=cfg.season_year and __SCHEMA__.canonical_round(g.round_label)='1st Round'
     and (g.result='pending' or (g.result<>'void' and g.graded_at is null))) into started;
  else
   select min(g.tip_time) into first_tip from __SCHEMA__.games g join __SCHEMA__.slates s on s.id=g.slate_id
    where s.season_year=cfg.season_year and not g.time_tbd and (cfg.starts_on is null or s.slate_date>=cfg.starts_on);
   started:=first_tip is not null and first_tip<=__SCHEMA__.contest_now();
  end if;
 end if;
 return jsonb_build_object('registered',registered,'alive',alive,'eliminated',eliminated,'started',started,'stopped',started and registered>0 and alive=0);
end $fn$;

create or replace function __SCHEMA__.refuse_picks_when_stopped() returns trigger language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
begin
 if TG_OP='UPDATE' and new.team is not distinct from old.team then return new; end if;
 if exists(select 1 from __SCHEMA__.players where status='alive') then return new; end if;
 if (__SCHEMA__.contest_state()->>'stopped')::boolean then raise exception 'The contest has no entries left alive; picks are closed'; end if;
 return new;
end $fn$;
drop trigger if exists picks_00_contest_stopped on __SCHEMA__.picks;
create trigger picks_00_contest_stopped before insert or update on __SCHEMA__.picks for each row execute function __SCHEMA__.refuse_picks_when_stopped();

create or replace function __SCHEMA__.results_attention() returns jsonb language plpgsql stable set search_path=__SCHEMA__,pg_catalog as $fn$
declare stalled jsonb; restore jsonb; now_ts timestamptz:=__SCHEMA__.contest_now();
begin
 select coalesce(jsonb_agg(jsonb_build_object('game_id',g.id,'slate_id',g.slate_id,'slate_number',s.slate_number,'home_team',g.home_team,'away_team',g.away_team,
   'tip_time',g.tip_time,'hours_late',floor(extract(epoch from now_ts-g.tip_time)/3600),
   'home_picks',(select count(*) from __SCHEMA__.picks where slate_id=g.slate_id and team=g.home_team),
   'away_picks',(select count(*) from __SCHEMA__.picks where slate_id=g.slate_id and team=g.away_team)) order by g.tip_time),'[]'::jsonb) into stalled
  from __SCHEMA__.games g join __SCHEMA__.slates s on s.id=g.slate_id
  where g.result='pending' and not g.time_tbd and g.tip_time+interval '6 hours'<=now_ts
   and (s.is_active or exists(select 1 from __SCHEMA__.picks where slate_id=s.id));
 select coalesce(jsonb_agg(jsonb_build_object('player_id',e.id,'name',e.full_name,'slate_number',e.elimination_slate,'reason',e.elimination_reason) order by e.full_name),'[]'::jsonb) into restore
  from __SCHEMA__.players e join __SCHEMA__.slates s on s.slate_number=e.elimination_slate
  where e.status='eliminated' and e.elimination_source='grading'
   and s.season_year=(select season_year from __SCHEMA__.pools where is_active limit 1)
   and __SCHEMA__.later_slate_locked(s.id) and not __SCHEMA__.entry_has_loss(e.id);
 return jsonb_build_object('stalled',stalled,'restore',restore,'count',jsonb_array_length(stalled)+jsonb_array_length(restore));
end $fn$;
$schema$;
  execute replace(ddl,'__SCHEMA__',target);
  for ddl in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=target and p.proname=any(array[
   'contest_now','clear_elimination_source','guard_manual_result','entry_has_loss','later_slate_locked','admin_set_result','release_result','void_game','unvoid_game','pick_impact','regrade_slate','contest_state','refuse_picks_when_stopped','results_attention']) loop
   execute 'revoke all on function '||ddl||' from public,anon,authenticated';
   execute 'grant execute on function '||ddl||' to service_role';
  end loop;
 end loop;
end $migration$;
notify pgrst,'reload schema';
commit;
