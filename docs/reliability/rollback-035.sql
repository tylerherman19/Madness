-- Rollback for migration 035: restores the mobile read functions exactly as

-- they were in production on 2026-11-15 (native-ios source, whitespace/comment-

-- normalized md5 matched production; get_pool_summary is production's own body).

-- Not a migration: never replayed by tooling. Run by hand only to undo 035.

begin;

create or replace function public.get_standings()
returns table (
  player_id uuid, full_name text, status text, elimination_slate int, elimination_reason text,
  days_survived int, seed_total int, has_current_pick boolean, current_picks text[], is_mine boolean
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_active public.slates;
  v_season int;
  v_revealed boolean := false;
  v_mine uuid[] := app_private.my_player_ids();
begin
  if auth.uid() is null then
    raise exception 'Sign in to see the standings.' using errcode = '28000';
  end if;

  select * into v_active from public.slates s where s.is_active limit 1;
  v_season := coalesce(v_active.season_year, (select max(s.season_year) from public.slates s));
  if v_active.id is not null then
    v_revealed := app_private.slate_is_revealed(v_active.id);
  end if;

  return query
  with season_picks as (
    select pk.player_id, pk.seed
    from public.picks pk join public.slates s on s.id = pk.slate_id
    where s.season_year = v_season
  )
  select
    p.id,
    p.full_name,
    p.status,
    p.elimination_slate,
    p.elimination_reason,
    (select count(*) from season_picks sp where sp.player_id = p.id)::int,
    coalesce((select sum(sp.seed) from season_picks sp where sp.player_id = p.id), 0)::int,
    exists (select 1 from public.picks pk where pk.player_id = p.id and pk.slate_id = v_active.id),
    case when v_revealed or p.id = any (v_mine) then
      (select array_agg(pk.team order by pk.created_at) from public.picks pk
        where pk.player_id = p.id and pk.slate_id = v_active.id)
    end,
    p.id = any (v_mine)
  from public.players p
  where not app_private.is_test_email(p.email) or p.id = any (v_mine)
  order by (p.status = 'alive') desc, p.full_name;
end;
$$;

create or replace function public.get_entry_picks(p_player_id uuid)
returns table (pick_id uuid, slate_id uuid, team text, seed int, auto_assigned boolean, submitted_by_admin boolean, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_mine boolean := p_player_id = any (app_private.my_player_ids());
begin
  if auth.uid() is null then
    raise exception 'Sign in to see pick history.' using errcode = '28000';
  end if;
  -- Test entries are invisible to everyone but their owner.
  if not v_mine and exists (select 1 from public.players p where p.id = p_player_id and app_private.is_test_email(p.email)) then
    return;
  end if;

  return query
  select pk.id, pk.slate_id, pk.team, pk.seed, pk.auto_assigned, pk.submitted_by_admin, pk.created_at
  from public.picks pk
  where pk.player_id = p_player_id
    and (v_mine or app_private.slate_is_revealed(pk.slate_id))
  order by pk.created_at;
end;
$$;

create or replace function public.get_slate_picks(p_slate_id uuid)
returns table (player_id uuid, full_name text, status text, elimination_slate int, has_pick boolean, team text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_slate public.slates;
  v_revealed boolean;
  v_mine uuid[] := app_private.my_player_ids();
begin
  if auth.uid() is null then
    raise exception 'Sign in to see picks.' using errcode = '28000';
  end if;
  select * into v_slate from public.slates s where s.id = p_slate_id;
  if v_slate.id is null then return; end if;
  v_revealed := app_private.slate_is_revealed(p_slate_id);

  return query
  select p.id, p.full_name, p.status, p.elimination_slate,
         exists (select 1 from public.picks pk where pk.player_id = p.id and pk.slate_id = p_slate_id),
         t.team
  from public.players p
  cross join lateral (
    select pk.team from public.picks pk
    where pk.player_id = p.id and pk.slate_id = p_slate_id and (v_revealed or p.id = any (v_mine))
    union all
    select null::text where not exists (
      select 1 from public.picks pk
      where pk.player_id = p.id and pk.slate_id = p_slate_id and (v_revealed or p.id = any (v_mine))
    )
  ) t
  where (p.status = 'alive' or p.elimination_slate = v_slate.slate_number)
    and (not app_private.is_test_email(p.email) or p.id = any (v_mine))
  order by p.full_name;
end;
$$;

create or replace function public.get_pool_summary()
returns table (total_entries int, alive_entries int, paid_entries int)
language sql stable security definer set search_path = '' as $$
  select count(*)::int,
         count(*) filter (where status = 'alive')::int,
         count(*) filter (where paid)::int
  from public.players
  where auth.uid() is not null
    and (not app_private.is_test_email(email) or id = any (app_private.my_player_ids()))
$$;

notify pgrst, 'reload schema';
commit;
