-- Mobile read functions: hidden picks must not move visible numbers (INT-01),
-- and only signed-in users who own an entry may read the pool (SEC-07).
--
-- The mobile API (schema app_private, deployed from the native-ios branch) is
-- not otherwise defined in this repository. Production's definitions were
-- compared with that branch on 2026-11-15 (whitespace/comment-normalized md5):
-- get_standings, get_slate_picks and get_entry_picks matched; get_pool_summary
-- in production already hides test entries except the caller's own.
--
-- INT-01: get_standings summed seed and counted picks over every pick of the
-- season, including days that have not locked and early next-day picks. A
-- rival could poll it and read the seed of a hidden pick. Both figures now
-- count a pick only when its day is revealed (app_private.slate_is_revealed,
-- the rule migration 034 aligned with the website) or the entry is the
-- caller's own. Mirrors src/lib/dashboard.ts, which totals revealed days only.
-- has_current_pick (active day only) is unchanged: the website shows the
-- same "has picked" flag (see INT-05 in the 2026-11-14 audit).
-- get_slate_picks.has_pick for a later, unrevealed day no longer shows
-- who has made an early next-day pick.
--
-- SEC-07: each read function now also requires that the caller owns at least
-- one entry. A signed-in user with no linked entry gets the same 28000 error
-- the shipped app already handles for a signed-out user (get_pool_summary
-- returns zeros, as it does today for a signed-out caller).
--
-- Guarded: a database built from this repository alone has no app_private
-- schema or mobile functions and skips this migration. Return types,
-- signatures, owners and grants are unchanged (create or replace keeps them).
-- Idempotent. Rollback: re-run the definitions captured before applying.
begin;
do $migration$
begin
  if to_regnamespace('app_private') is null
     or to_regprocedure('app_private.my_player_ids()') is null
     or to_regprocedure('app_private.slate_is_revealed(uuid)') is null
     or to_regprocedure('app_private.is_test_email(text)') is null
     or to_regprocedure('public.get_standings()') is null then
    return;
  end if;

  create or replace function public.get_standings()
  returns table (
    player_id uuid, full_name text, status text, elimination_slate int, elimination_reason text,
    days_survived int, seed_total int, has_current_pick boolean, current_picks text[], is_mine boolean
  )
  language plpgsql stable security definer set search_path = '' as $fn$
  declare
    v_active public.slates;
    v_season int;
    v_revealed boolean := false;
    v_mine uuid[] := app_private.my_player_ids();
  begin
    if auth.uid() is null or cardinality(v_mine) = 0 then
      raise exception 'Sign in to see the standings.' using errcode = '28000';
    end if;

    select * into v_active from public.slates s where s.is_active limit 1;
    v_season := coalesce(v_active.season_year, (select max(s.season_year) from public.slates s));
    if v_active.id is not null then
      v_revealed := app_private.slate_is_revealed(v_active.id);
    end if;

    return query
    with season_slates as (
      select s.id, app_private.slate_is_revealed(s.id) as revealed
      from public.slates s where s.season_year = v_season
    ),
    season_picks as (
      -- A pick counts toward the visible figures only once its day is
      -- revealed, or when it belongs to the caller.
      select pk.player_id, pk.seed
      from public.picks pk join season_slates ss on ss.id = pk.slate_id
      where ss.revealed or pk.player_id = any (v_mine)
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
  $fn$;

  if to_regprocedure('public.get_entry_picks(uuid)') is not null then
    create or replace function public.get_entry_picks(p_player_id uuid)
    returns table (pick_id uuid, slate_id uuid, team text, seed int, auto_assigned boolean, submitted_by_admin boolean, created_at timestamptz)
    language plpgsql stable security definer set search_path = '' as $fn$
    declare
      v_ids uuid[] := app_private.my_player_ids();
      v_mine boolean := p_player_id = any (v_ids);
    begin
      if auth.uid() is null or cardinality(v_ids) = 0 then
        raise exception 'Sign in to see pick history.' using errcode = '28000';
      end if;
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
    $fn$;
  end if;

  if to_regprocedure('public.get_slate_picks(uuid)') is not null then
    create or replace function public.get_slate_picks(p_slate_id uuid)
    returns table (player_id uuid, full_name text, status text, elimination_slate int, has_pick boolean, team text)
    language plpgsql stable security definer set search_path = '' as $fn$
    declare
      v_slate public.slates;
      v_revealed boolean;
      v_mine uuid[] := app_private.my_player_ids();
    begin
      if auth.uid() is null or cardinality(v_mine) = 0 then
        raise exception 'Sign in to see picks.' using errcode = '28000';
      end if;
      select * into v_slate from public.slates s where s.id = p_slate_id;
      if v_slate.id is null then return; end if;
      v_revealed := app_private.slate_is_revealed(p_slate_id);

      -- "Has picked" is public only for the active day (as on the website) or
      -- once the day is revealed. For a later day it would show who has
      -- already made an early next-day pick.
      return query
      select p.id, p.full_name, p.status, p.elimination_slate,
             (v_slate.is_active or v_revealed or p.id = any (v_mine))
               and exists (select 1 from public.picks pk where pk.player_id = p.id and pk.slate_id = p_slate_id),
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
    $fn$;
  end if;

  if to_regprocedure('public.get_pool_summary()') is not null then
    create or replace function public.get_pool_summary()
    returns table (total_entries int, alive_entries int, paid_entries int)
    language sql stable security definer set search_path = '' as $fn$
      select count(*)::int,
             count(*) filter (where status = 'alive')::int,
             count(*) filter (where paid)::int
      from public.players
      where auth.uid() is not null
        and cardinality(app_private.my_player_ids()) > 0
        and (not app_private.is_test_email(email) or id = any (app_private.my_player_ids()))
    $fn$;
  end if;
end $migration$;
notify pgrst, 'reload schema';
commit;
