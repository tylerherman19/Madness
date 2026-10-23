-- Additive; preserves picked games and records review without rewriting results.
-- A pick takes a slate SHARE lock. Identity changes take the same slate UPDATE
-- lock before a fresh READ COMMITTED pick query, closing the read/upsert race.
begin;
do $migration$
declare target text; ddl text;
begin
 foreach target in array array['public','sandbox'] loop
  ddl := $schema$
create or replace function __SCHEMA__.guard_picked_schedule()
returns trigger language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
declare changed boolean; next_slate uuid; sid uuid;
begin
 if TG_OP='DELETE' then
  changed:=true; next_slate:=old.slate_id;
 else
  next_slate:=new.slate_id;
  -- Filling a previously unknown stable ID is a compatible legacy backfill.
  changed:=new.id is distinct from old.id or new.espn_event_id is distinct from old.espn_event_id
   or new.slate_id is distinct from old.slate_id
   or new.home_team is distinct from old.home_team or new.away_team is distinct from old.away_team
   or (old.home_team_id is not null and new.home_team_id is distinct from old.home_team_id)
   or (old.away_team_id is not null and new.away_team_id is distinct from old.away_team_id);
 end if;
 if not changed then return new; end if;
 -- A repeatable-read snapshot could predate a pick committed during the wait.
 if current_setting('transaction_isolation') <> 'read committed' then
  raise exception 'Schedule identity changes require READ COMMITTED isolation';
 end if;
 for sid in select id from __SCHEMA__.slates where id in(old.slate_id,next_slate) order by id for update loop
  null;
 end loop;
 -- Do not acquire player/pick row locks: the pick path locks player, then slate.
 -- Any pick in the original period conservatively freezes its game identities.
 if exists(select 1 from __SCHEMA__.picks where slate_id=old.slate_id or game_id=old.id) then
  perform __SCHEMA__.record_incident('schedule-change:'||old.id,
   'A picked schedule changed. Review the game, period and affected entries before any correction.',
   gen_random_uuid(),jsonb_build_object('game_id',old.id,'old_slate_id',old.slate_id,
    'requested_slate_id',next_slate,'operation',TG_OP)::text);
  insert into __SCHEMA__.audit_log(event_type,actor,message,details) values
   ('schedule-change','system','Picked game preserved for manual schedule review',
    jsonb_build_object('game_id',old.id,'old_slate_id',old.slate_id,'requested_slate_id',next_slate,'operation',TG_OP));
  -- RAISE would roll back the incident. Skipping this row preserves both the
  -- linkage and all previous outcomes; upsert callers verify returned rows.
  return null;
 end if;
 if TG_OP='DELETE' then return old; end if;
 return new;
end $fn$;
drop trigger if exists games_00_schedule_guard on __SCHEMA__.games;
create trigger games_00_schedule_guard before update or delete on __SCHEMA__.games
 for each row execute function __SCHEMA__.guard_picked_schedule();

-- A legitimate move before picks must remove the event from its OLD snapshot
-- as well as adding it to the NEW snapshot. Locked snapshots remain evidence.
create or replace function __SCHEMA__.freeze_assignment_schedule()
returns trigger language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
declare sid uuid; old_sid uuid; new_sid uuid; lock_at timestamptz; frozen jsonb;
begin
 if TG_OP<>'INSERT' then old_sid:=old.slate_id; end if;
 if TG_OP<>'DELETE' then new_sid:=new.slate_id; end if;
 for sid in select id from __SCHEMA__.slates where id in(old_sid,new_sid) order by id for update loop
  select locks_at,assignment_schedule into lock_at,frozen from __SCHEMA__.slates where id=sid;
  if frozen is null or lock_at is null or clock_timestamp()<lock_at then
   update __SCHEMA__.slates set assignment_schedule=(
    select coalesce(jsonb_agg(jsonb_build_object('id',id,'slate_id',slate_id,
     'home_team',home_team,'away_team',away_team,'home_seed',home_seed,'away_seed',away_seed,
     'round_label',round_label,'tip_time',tip_time,'time_tbd',time_tbd)
     order by tip_time desc,espn_event_id),'[]'::jsonb) from __SCHEMA__.games where slate_id=sid
   ) where id=sid;
  end if;
 end loop;
 return null;
end $fn$;
$schema$;
  execute replace(ddl,'__SCHEMA__',target);
  execute format('revoke all on function %I.guard_picked_schedule() from public,anon,authenticated',target);
  execute format('revoke all on function %I.freeze_assignment_schedule() from public,anon,authenticated',target);
 end loop;
end $migration$;
commit;
