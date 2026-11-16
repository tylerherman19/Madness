-- Real game dates stay intact for results. Both Elite Eight slates share
-- Saturday's submission deadline, quota, and assignment lease.
begin;
set local lock_timeout='5s';
do $migration$
declare s text; ddl text; patch record;
begin
foreach s in array array['public','sandbox'] loop
 execute replace($sql$
 create or replace function __S__.march_2027_round(d date) returns text
 language sql immutable set search_path=pg_catalog as $fn$
 select case d
  when date '2027-03-18' then '1st Round' when date '2027-03-19' then '1st Round'
  when date '2027-03-20' then '2nd Round' when date '2027-03-21' then '2nd Round'
  when date '2027-03-25' then 'Sweet 16' when date '2027-03-26' then 'Sweet 16'
  when date '2027-03-27' then 'Elite 8' when date '2027-03-28' then 'Elite 8'
  when date '2027-04-03' then 'Final Four' when date '2027-04-05' then 'National Championship'
 end
 $fn$;

 create or replace function __S__.march_2027_elite_anchor(p_slate uuid) returns uuid
 language sql stable set search_path=__S__,pg_catalog as $fn$
 select sat.id from __S__.slates d join __S__.slates sat on sat.season_year=d.season_year and sat.slate_date=date '2027-03-27'
 where d.id=p_slate and d.season_year=2027 and d.slate_date in (date '2027-03-27',date '2027-03-28')
 and exists(select 1 from __S__.pools where is_active and competition_mode='march-madness' and season_year=2027)
 $fn$;

 create or replace function __S__.march_2027_pick_deadline(p_slate uuid) returns timestamptz
 language sql stable set search_path=__S__,pg_catalog as $fn$
 select least(d.locks_at,(select min(g.tip_time) from __S__.games g where g.slate_id=d.id and not g.time_tbd))
 from __S__.slates d where d.id=coalesce(__S__.march_2027_elite_anchor(p_slate),p_slate)
 $fn$;

 create or replace function __S__.march_2027_elite_ready(p_anchor uuid) returns boolean
 language sql stable set search_path=__S__,pg_catalog as $fn$
 select count(*)=4 and count(distinct d.id)=2 and count(distinct g.espn_event_id)=4
   and bool_and(coalesce(__S__.canonical_round(g.round_label)='Elite 8' and not g.time_tbd
    and g.home_team_id<>g.away_team_id and g.home_seed between 1 and 16 and g.away_seed between 1 and 16,false))
   and count(*) filter(where d.id=p_anchor)=2
 from __S__.slates d join __S__.games g on g.slate_id=d.id
 where __S__.march_2027_elite_anchor(d.id)=p_anchor
 $fn$;

 create or replace function __S__.guard_march_2027_slate() returns trigger
 language plpgsql set search_path=__S__,pg_catalog as $fn$
 begin
  if new.is_active and exists(select 1 from __S__.pools where is_active and competition_mode='march-madness' and season_year=2027) then
   if new.season_year<>2027 or __S__.march_2027_round(new.slate_date) is null
      or not exists(select 1 from __S__.games where slate_id=new.id)
      or exists(select 1 from __S__.games where slate_id=new.id and __S__.canonical_round(round_label) is distinct from __S__.march_2027_round(new.slate_date))
   then raise exception 'This slate is outside the 2027 tournament schedule'; end if;
  end if;
  return new;
 end $fn$;
 drop trigger if exists slates_march_2027_schedule on __S__.slates;
 create trigger slates_march_2027_schedule before update of is_active on __S__.slates
 for each row execute function __S__.guard_march_2027_slate();
 $sql$,'__S__',s);

 -- Retain the existing version, receipt, row-lock and lease machinery.
 -- Every replacement has a prerequisite; abort instead of partially patching
 -- when the installed function differs.
 for patch in select * from (values
  ('enforce_pick_integrity()', 'and (new.player_id <> old.player_id or new.slate_id <> old.slate_id)',
   'and (new.player_id <> old.player_id or (new.slate_id <> old.slate_id and not coalesce(__S__.march_2027_elite_anchor(new.slate_id)=__S__.march_2027_elite_anchor(old.slate_id),false)))'),
  ('enforce_pick_integrity()', 'lock_at := least(s.locks_at, first_tip);',
   $text$lock_at := __S__.march_2027_pick_deadline(s.id);
        if cfg.competition_mode='march-madness' and cfg.season_year=2027 then
         if cfg.status not in ('open','live') or __S__.march_2027_round(s.slate_date) is null
          or not exists(select 1 from __S__.games where slate_id=s.id and new.team in(home_team,away_team)
           and __S__.canonical_round(round_label)=__S__.march_2027_round(s.slate_date))
         then raise exception 'Pick period is not open for the 2027 tournament'; end if;
         if s.slate_date in (date '2027-03-27',date '2027-03-28')
            and not __S__.march_2027_elite_ready(__S__.march_2027_elite_anchor(s.id))
         then raise exception 'Both Elite Eight schedules are required'; end if;
        end if;$text$),
  ('enforce_pick_integrity()', 'if not s.is_active and not __S__.can_pick_early(new.player_id,s.id)',
   $text$if not s.is_active and not exists(select 1 from __S__.slates where id=__S__.march_2027_elite_anchor(s.id) and is_active)
         and not __S__.can_pick_early(new.player_id,coalesce(__S__.march_2027_elite_anchor(s.id),s.id))$text$),
  ('freeze_assignment_schedule()', 'select locks_at,assignment_schedule into lock_at,frozen',
   'select case when __S__.march_2027_elite_anchor(sid) is not null then __S__.march_2027_pick_deadline(sid) else locks_at end, assignment_schedule into lock_at, frozen'),
  ('enforce_pick_integrity()', 'ss.id=new.slate_id and ss.assignment_token',
   'ss.id=coalesce(__S__.march_2027_elite_anchor(new.slate_id),new.slate_id) and ss.assignment_token'),
  ('save_pick(uuid,uuid,text,uuid,uuid,timestamptz,text,text)', 'and slate_id=p_slate_id for update;',
   'and (slate_id=p_slate_id or __S__.march_2027_elite_anchor(slate_id)=__S__.march_2027_elite_anchor(p_slate_id)) for update;'),
  ('save_pick(uuid,uuid,text,uuid,uuid,timestamptz,text,text)', 'set team=p_team,seed=',
   'set slate_id=p_slate_id,team=p_team,seed='),
  ('save_pick(uuid,uuid,text,uuid,uuid,timestamptz,text,text)', 'select least(s.locks_at,(select min(tip_time) from __S__.games where slate_id=s.id and not time_tbd)) into deadline',
   'select __S__.march_2027_pick_deadline(s.id) into deadline'),
  ('active_pick_requirement()', 'least(s.locks_at,(select min(tip_time) from __S__.games where slate_id=s.id and not time_tbd))',
   '__S__.march_2027_pick_deadline(s.id)'),
  ('apply_assignment(uuid,uuid,uuid,jsonb,text,uuid[],integer)', 'values(p_player_id,p_slate_id,t->>',
   'values(p_player_id,case when __S__.march_2027_elite_anchor((t->>''slate_id'')::uuid)=p_slate_id then (t->>''slate_id'')::uuid else p_slate_id end,t->>')
 ) p(signature,needle,replacement) loop
  select pg_get_functiondef(to_regprocedure(s||'.'||patch.signature)) into ddl;
  if strpos(ddl,replace(patch.replacement,'__S__',s))>0 then continue; end if;
  if ddl is null or strpos(ddl,replace(patch.needle,'__S__',s))=0 then
   raise exception 'Unexpected function definition: %.%',s,patch.signature;
  end if;
  execute replace(ddl,replace(patch.needle,'__S__',s),replace(patch.replacement,'__S__',s));
 end loop;

 execute replace($acl$
 revoke all on function __S__.march_2027_round(date), __S__.march_2027_elite_anchor(uuid),
  __S__.march_2027_pick_deadline(uuid), __S__.march_2027_elite_ready(uuid), __S__.guard_march_2027_slate()
  from public,anon,authenticated;
 grant execute on function __S__.march_2027_round(date), __S__.march_2027_elite_anchor(uuid),
  __S__.march_2027_pick_deadline(uuid), __S__.march_2027_elite_ready(uuid), __S__.guard_march_2027_slate()
  to service_role;
 $acl$,'__S__',s);
end loop;
end $migration$;
notify pgrst,'reload schema';
commit;
