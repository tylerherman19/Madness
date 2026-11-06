-- Existing review rows remain visible, but the three feed workloads can
-- probe again when their capped backoff expires. One-off mutations stay parked.
begin;
do $migration$
declare target text;
begin
 foreach target in array array['public','sandbox'] loop
  execute replace($ddl$
   create or replace function __SCHEMA__.claim_operation(p_key text, p_seconds integer default 240)
   returns uuid language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
   declare claimed uuid;
   begin
    insert into __SCHEMA__.operation_runs(key) values(p_key) on conflict do nothing;
    update __SCHEMA__.operation_runs set token=gen_random_uuid(),
     lease_until=clock_timestamp()+make_interval(secs=>least(300,greatest(10,p_seconds))),
     attempts=attempts+1,status='running',updated_at=clock_timestamp()
     where key=p_key and status<>'done'
      and (status<>'review' or key in ('recurring:schedule','recurring:results','recurring:advance'))
      and next_attempt_at<=clock_timestamp()
      and (lease_until is null or lease_until<=clock_timestamp()) returning token into claimed;
    return claimed;
   end $fn$;

   create or replace function __SCHEMA__.activate_ready_slate(
    p_expected uuid,p_next uuid,p_held uuid[],p_require_open boolean
   ) returns void language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
   declare previous __SCHEMA__.slates%rowtype; next_day __SCHEMA__.slates%rowtype;
   begin
    perform pg_advisory_xact_lock(hashtextextended('__SCHEMA__.active-slate',0));
    perform id from __SCHEMA__.slates where id in (p_expected,p_next) order by id for update;
    select * into previous from __SCHEMA__.slates where id=p_expected;
    select * into next_day from __SCHEMA__.slates where id=p_next;
    if previous.is_active is distinct from true or previous.auto_assign_completed_at is null then
     raise exception 'Active day changed or assignments incomplete';
    end if;
    if next_day.id is null or next_day.slate_date<=previous.slate_date or next_day.season_year<>previous.season_year then
     raise exception 'Invalid next day';
    end if;
    if p_require_open and (next_day.locks_at is null or next_day.locks_at<=clock_timestamp()) then
     raise exception 'Next pick day is already locked';
    end if;
    if not exists(select 1 from __SCHEMA__.games where slate_id=p_expected)
       or exists(select 1 from __SCHEMA__.games where slate_id=p_expected and result='pending'
         and not (id=any(coalesce(p_held,'{}'::uuid[])))) then
     raise exception 'Results incomplete';
    end if;
    -- Every unexcused pick must have a confirmed result in its linked game
    -- (or an unambiguous team match for a legacy pick).
    if exists(select 1 from __SCHEMA__.picks pp where pp.slate_id=p_expected and not pp.loss_excused
       and (select count(*) from __SCHEMA__.games g
        where g.slate_id=pp.slate_id and (pp.game_id is null or pp.game_id=g.id)
         and pp.team in (g.home_team,g.away_team) and g.result<>'pending'
         and not (g.id=any(coalesce(p_held,'{}'::uuid[])))) <> 1) then
     raise exception 'A pick still needs a confirmed result';
    end if;
    if exists(select 1 from __SCHEMA__.picks pp join __SCHEMA__.players p on p.id=pp.player_id
      join __SCHEMA__.games g on g.slate_id=pp.slate_id and (pp.game_id is null or pp.game_id=g.id)
      where pp.slate_id=p_expected and p.status='alive' and not pp.loss_excused
       and ((pp.team=g.home_team and g.result in ('away_win','tie')) or (pp.team=g.away_team and g.result in ('home_win','tie')))) then
     raise exception 'Grading incomplete';
    end if;
    perform __SCHEMA__.activate_slate(p_next);
   end $fn$;
   revoke all on function __SCHEMA__.activate_ready_slate(uuid,uuid,uuid[],boolean) from public,anon,authenticated;
   grant execute on function __SCHEMA__.activate_ready_slate(uuid,uuid,uuid[],boolean) to service_role;
  $ddl$, '__SCHEMA__', target);
 end loop;
end $migration$;
notify pgrst,'reload schema';
commit;
