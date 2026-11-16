-- Stage the 2027 rules without switching pools or changing contest records.
begin;
set local lock_timeout = '5s';
do $migration$
declare s text; ddl text; original text; needle text;
begin
foreach s in array array['public','sandbox'] loop
 execute replace($sql$
 create or replace function __S__.march_2027_opening_ready(p_slate uuid) returns boolean
 language sql stable set search_path=__S__,pg_catalog as $fn$
  select exists (
   select 1 from __S__.slates d join __S__.games g on g.slate_id=d.id
   where d.id=p_slate and d.season_year=2027 and d.slate_date=date '2027-03-18'
   group by d.id
   having count(*)=16 and count(distinct g.espn_event_id)=16
   and bool_and(coalesce(__S__.canonical_round(g.round_label)='1st Round'
    and g.espn_event_id<>'' and g.home_team_id is not null and g.away_team_id is not null
    and g.home_team_id<>g.away_team_id
    and g.home_seed between 1 and 16 and g.away_seed between 1 and 16
    and not g.time_tbd and g.result='pending' and g.status_state='pre',false))
   and (select count(distinct team_id) from __S__.games x
     cross join lateral (values (x.home_team_id),(x.away_team_id)) t(team_id) where x.slate_id=d.id)=32
  );
 $fn$;
 revoke all on function __S__.march_2027_opening_ready(uuid) from public,anon,authenticated;
 grant execute on function __S__.march_2027_opening_ready(uuid) to service_role;

 create or replace function __S__.guard_march_2027_pool() returns trigger
 language plpgsql set search_path=__S__,pg_catalog as $fn$
 begin
  if new.competition_mode='march-madness' and new.season_year=2027 then
   if new.starts_on is distinct from date '2027-03-18' or new.pick_frequency<>'every-game-day'
     or new.pick_deadline_rule<>'first-tip' or new.team_reuse_rule<>'once-per-pool'
     or new.auto_pick_behavior<>'highest-seed' or new.tiebreaker<>'seed-total' then
    raise exception '2027 March Madness starts March 18 and must use the published rules';
   end if;
   if tg_op='UPDATE' and (old.competition_mode,old.season_year) is distinct from (new.competition_mode,new.season_year)
     then raise exception 'Use Archive and start March Madness to open a separate contest'; end if;
  elsif tg_op='UPDATE' and old.competition_mode='march-madness' and old.season_year=2027 and old.is_active then
   raise exception 'Cannot change the format or year of the active 2027 tournament';
  end if;
  return new;
 end $fn$;
 revoke all on function __S__.guard_march_2027_pool() from public,anon,authenticated;
 drop trigger if exists pools_march_2027_rules on __S__.pools;
 create trigger pools_march_2027_rules before insert or update on __S__.pools
 for each row execute function __S__.guard_march_2027_pool();
 $sql$,'__S__',s);

 -- Preserve the existing atomic archive/switch contract and ACL. Refuse to
 -- install on a different definition so deployment cannot silently skip a guard.
 select pg_get_functiondef(to_regprocedure(s||'.start_fresh_tournament(uuid,uuid,text,text)')) into original;
 if strpos(original, 'march_2027_opening_ready')>0 then continue; end if;
 needle := '      select least(first_day.locks_at, min(tip_time)) into lock_at';
 if original is null or strpos(original,needle)=0
    or strpos(original, '''tournament-round'', ''first-tip'', ''once-per-pool''')=0 then
   raise exception 'Unexpected start_fresh_tournament definition in %',s;
 end if;
 ddl:=replace(original,needle,replace($guard$
      if cfg.season_year=2027 and first_day.season_year<>2027 then
       raise exception 'Choose the 2027 tournament opening day';
      end if;
      if first_day.season_year=2027 then
       if first_day.slate_date<>date '2027-03-18' then
        raise exception 'March 18 is the only 2027 tournament opening day';
       end if;
       if not __S__.march_2027_opening_ready(p_slate_id) then
        raise exception 'March 18 needs all 16 verified Round of 64 matchups with teams, seeds and tip times';
       end if;
       if exists(select 1 from __S__.pools where competition_mode='march-madness' and season_year=2027) then
        raise exception 'The 2027 tournament already exists';
       end if;
      end if;
 $guard$,'__S__',s)||needle);
 ddl:=replace(ddl,'''tournament-round'', ''first-tip'', ''once-per-pool''',
   'case when first_day.season_year=2027 then ''every-game-day'' else ''tournament-round'' end, ''first-tip'', ''once-per-pool''');
 execute ddl;
end loop;
end $migration$;
notify pgrst,'reload schema';
commit;
