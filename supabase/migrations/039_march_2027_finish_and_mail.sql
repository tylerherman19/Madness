-- Final standings and notification intents. Delivery settings remain unchanged.
begin;
set local lock_timeout='5s';
do $migration$
declare s text; ddl text;
begin
foreach s in array array['public','sandbox'] loop
 select pg_get_functiondef(to_regprocedure(s||'.protect_frozen_rules()')) into ddl;
 if strpos(ddl,'''final_result''')=0 then
  if strpos(ddl,'''updated_at'',''status'',''name'',''is_active''')=0 then
   raise exception 'Unexpected frozen rule guard in %',s;
  end if;
  execute replace(ddl,'''updated_at'',''status'',''name'',''is_active''','''updated_at'',''status'',''name'',''is_active'',''final_result''');
 end if;
 execute replace($sql$
 alter table __S__.pools add column if not exists final_result jsonb;

 create or replace function __S__.march_2027_welcome() returns trigger
 language plpgsql set search_path=__S__,pg_catalog as $fn$
 declare cfg __S__.pools%rowtype;
 begin
  select * into cfg from __S__.pools where is_active for share;
  if cfg.season_year=2027 and cfg.competition_mode='march-madness' then
   if cfg.status not in ('open','live') or not exists(
     select 1 from __S__.slates d where d.season_year=2027 and d.slate_date=date '2027-03-18'
       and __S__.march_2027_pick_deadline(d.id)>case when '__S__'='sandbox'
         then (select coalesce(simulated_now,clock_timestamp()) from sandbox.clock where id) else clock_timestamp() end
   ) then raise exception '2027 tournament registration has closed'; end if;
   insert into __S__.notification_outbox(event_key,kind,player_id,recipient,payload,priority)
   values('march-2027-welcome:'||new.id,'welcome',new.id,new.email,jsonb_build_object('name',new.full_name),25)
   on conflict(event_key) do nothing;
  end if;
  return new;
 end $fn$;
 drop trigger if exists players_march_2027_welcome on __S__.players;
 create trigger players_march_2027_welcome after insert on __S__.players
 for each row execute function __S__.march_2027_welcome();

 create or replace function __S__.finish_march_2027(p_slate uuid) returns jsonb
 language plpgsql set search_path=__S__,pg_catalog as $fn$
 declare cfg __S__.pools%rowtype; d __S__.slates%rowtype; alive integer; last_out integer; outcome jsonb;
 begin
  perform pg_advisory_xact_lock(hashtextextended('__S__.active-slate',0));
  select * into cfg from __S__.pools where is_active and season_year=2027 and competition_mode='march-madness' for update;
  if not found then return null; end if;
  if cfg.status='completed' then return cfg.final_result; end if;
  select * into d from __S__.slates where id=p_slate and is_active for update;
  if not found or d.slate_date=date '2027-03-27' or d.auto_assign_completed_at is null
   or not exists(select 1 from __S__.games where slate_id=d.id)
   or exists(select 1 from __S__.games where slate_id=d.id and result='pending')
   or exists(select 1 from __S__.picks p join __S__.players e on e.id=p.player_id
     join __S__.games g on g.slate_id=p.slate_id and p.team in(g.home_team,g.away_team)
     where p.slate_id=d.id and e.status='alive' and not p.loss_excused
       and (g.result='tie' or (g.result='home_win' and p.team=g.away_team) or (g.result='away_win' and p.team=g.home_team)))
  then return null; end if;
  select count(*) filter(where status='alive'),max(elimination_slate) into alive,last_out from __S__.players where email not like '%@nflsurvivor.internal';
  if (alive>1 and d.slate_date<>date '2027-04-05') or (alive=0 and last_out is null) then return null; end if;

  with eligible as (
   select e.id,e.full_name from __S__.players e
   where e.email not like '%@nflsurvivor.internal' and ((alive>0 and e.status='alive') or (alive=0 and e.elimination_slate=last_out))
  ), scores as (
   select e.id,e.full_name, coalesce((
    select sum(p.seed) from __S__.picks p join __S__.slates sd on sd.id=p.slate_id
    where p.player_id=e.id and p.seed between 1 and 16 and sd.season_year=2027 and sd.slate_date between cfg.starts_on and d.slate_date
    and exists(select 1 from __S__.games g where g.slate_id=p.slate_id and (p.game_id is null or p.game_id=g.id)
      and ((p.team=g.home_team and g.result='home_win') or (p.team=g.away_team and g.result='away_win')))
   ),0) as score from eligible e
  ) select jsonb_build_object('decided_on',d.slate_date,'reason',
    case when alive=1 then 'last-survivor' when alive=0 then 'all-eliminated' else 'championship-tie' end,
    'winners',jsonb_agg(jsonb_build_object('name',full_name,'seed_total',score) order by full_name,id))
  into outcome from scores where score=(select max(score) from scores);
  update __S__.pools set status='completed',final_result=outcome,updated_at=clock_timestamp() where id=cfg.id;
  update __S__.slates set is_active=false where id=d.id;
  insert into __S__.audit_log(event_type,actor,message,details)
   values('tournament-completed','system','2027 tournament finalized',outcome);
  return outcome;
 end $fn$;

 create or replace function __S__.queue_march_2027_recap(p_slate uuid,p_production boolean) returns boolean
 language plpgsql set search_path=__S__,pg_catalog as $fn$
 declare cfg __S__.pools%rowtype; d __S__.slates%rowtype; scores text; alive integer; eliminated integer; winners text;
 begin
  select * into cfg from __S__.pools where is_active and season_year=2027 and competition_mode='march-madness';
  if not found then return false; end if;
  select * into d from __S__.slates where id=p_slate and season_year=2027;
  if not found or __S__.march_2027_round(d.slate_date) is null
     or d.auto_assign_completed_at is null
     or d.slate_date < (clock_timestamp() at time zone 'America/Chicago')::date-1
     or (not d.is_active and d.slate_date::text is distinct from (cfg.final_result->>'decided_on'))
     or exists(select 1 from __S__.games where slate_id=d.id and result='pending')
  then return false; end if;
  select string_agg(case result when 'home_win' then home_team||' over '||away_team
      when 'away_win' then away_team||' over '||home_team else home_team||' vs '||away_team||': '||result end,E'\n' order by tip_time,id)
  into scores from __S__.games where slate_id=d.id;
  if scores is null then return false; end if;
  select count(*) filter(where status='alive'), count(*) filter(where elimination_slate=d.slate_number)
    into alive,eliminated from __S__.players;
  select string_agg(x->>'name',', ') into winners from jsonb_array_elements(cfg.final_result->'winners') x;
  insert into __S__.email_campaigns(request_id,subject,message,contest_id,audience,actor,slate_id,provenance)
  values(d.id,'March Madness results: '||to_char(d.slate_date,'FMMonth FMDD'),
    scores||E'\n\n'||alive||' entries still alive; '||eliminated||' eliminated today.'||
    case when winners is not null then E'\nWinner(s): '||winners else '' end,
    cfg.id,'all','march-2027-recap',d.id,case when p_production and '__S__'='public' then 'production' else 'test' end)
  on conflict(request_id) do nothing;
  return found;
 end $fn$;
 revoke all on function __S__.march_2027_welcome(),__S__.finish_march_2027(uuid),
  __S__.queue_march_2027_recap(uuid,boolean) from public,anon,authenticated;
 grant execute on function __S__.finish_march_2027(uuid),__S__.queue_march_2027_recap(uuid,boolean) to service_role;
 $sql$,'__S__',s);
end loop;
end $migration$;
notify pgrst,'reload schema';
commit;
