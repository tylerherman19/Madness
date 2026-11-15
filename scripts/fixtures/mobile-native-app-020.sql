-- Native iOS app support.
--
-- WHY: the iPhone app has to ship the project's *publishable* (anon) key, and
-- anyone can pull that key out of an app. Until now the key was never
-- published, which hid a real hole: migrations 014 and 017 left row-level
-- security OFF on slates, teams, games, picks and pools, and Supabase grants
-- the public API roles full access to public tables by default. With the key,
-- anyone could read hidden picks, change picks, rewrite results, move lock
-- times and change pool rules.
--
-- WHAT THIS DOES (additive only — no existing row, column or table changes):
--   1. Row-level security ON for every pool table (public + sandbox).
--   2. Signed-in users may READ the non-sensitive tables (slates, games,
--      teams, pools). Nobody outside the server may write anything.
--   3. players, picks, audit_log, rate_limits: no direct API access at all.
--   4. New tables: player_accounts (login -> entries), notification
--      preferences, push devices.
--   5. SECURITY DEFINER functions that apply the pool's privacy and pick rules
--      in the database, with the database clock.
--
-- The website is unaffected: it uses the service-role key, which bypasses
-- row-level security and these grants entirely.
--
-- Safe to re-run.

-- ------------------------------------------------------------------ 1. RLS

alter table public.slates enable row level security;
alter table public.teams  enable row level security;
alter table public.games  enable row level security;
alter table public.picks  enable row level security;
alter table public.pools  enable row level security;
-- Already on since 002/012/003; restated so this file is the whole picture.
alter table public.players     enable row level security;
alter table public.audit_log   enable row level security;
alter table public.rate_limits enable row level security;

do $$
declare t text;
begin
  foreach t in array array['slates','teams','games','picks','pools','players','audit_log','clock'] loop
    if to_regclass('sandbox.' || t) is not null then
      execute format('alter table sandbox.%I enable row level security', t);
    end if;
  end loop;
end
$$;

-- ------------------------------------------------------------ 2. Privileges

-- Sensitive tables: nothing for the public API roles, ever.
revoke all on public.players, public.picks, public.audit_log, public.rate_limits
  from anon, authenticated;

-- Schedule and configuration: read-only, signed-in users only.
revoke all on public.slates, public.games, public.teams, public.pools from anon, authenticated;
grant select on public.slates, public.games, public.teams, public.pools to authenticated;

drop policy if exists "Signed-in users read slates" on public.slates;
create policy "Signed-in users read slates" on public.slates for select to authenticated using (true);
drop policy if exists "Signed-in users read games" on public.games;
create policy "Signed-in users read games" on public.games for select to authenticated using (true);
drop policy if exists "Signed-in users read teams" on public.teams;
create policy "Signed-in users read teams" on public.teams for select to authenticated using (true);
drop policy if exists "Signed-in users read pools" on public.pools;
create policy "Signed-in users read pools" on public.pools for select to authenticated using (true);

-- Postgres lets everyone execute a new function by default.
revoke execute on function public.bump_rate_limit(text, integer, integer) from public, anon, authenticated;

-- ------------------------------------------------------------- 3. Tables

-- Which Supabase Auth user owns which survivor entry. One login may own
-- several entries; one entry belongs to one login. Written only by the
-- mobile-sign-in Edge Function (service role).
create table if not exists public.player_accounts (
  user_id    uuid not null references auth.users (id) on delete cascade,
  player_id  uuid not null references public.players (id) on delete cascade,
  linked_via text not null default 'password' check (linked_via in ('password', 'apple', 'admin')),
  linked_at  timestamptz not null default now(),
  primary key (user_id, player_id)
);
create unique index if not exists player_accounts_one_owner on public.player_accounts (player_id);
alter table public.player_accounts enable row level security;
revoke all on public.player_accounts from anon, authenticated;

-- What each user wants to hear about. Read by the future push sender.
create table if not exists public.notification_preferences (
  user_id          uuid primary key references auth.users (id) on delete cascade,
  pick_reminders   boolean not null default true,
  urgent_reminders boolean not null default true,
  results          boolean not null default true,
  big_eliminations boolean not null default true,
  game_alerts      boolean not null default false,
  updated_at       timestamptz not null default now()
);
alter table public.notification_preferences enable row level security;
revoke all on public.notification_preferences from anon, authenticated;

-- APNs device tokens. Filled once remote push exists (needs the paid Apple
-- Developer Program); the table is here so the app and sender agree on shape.
create table if not exists public.push_devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  token        text not null unique,
  platform     text not null default 'ios' check (platform in ('ios')),
  environment  text not null default 'production' check (environment in ('sandbox', 'production')),
  app_version  text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists push_devices_user_idx on public.push_devices (user_id);
alter table public.push_devices enable row level security;
revoke all on public.push_devices from anon, authenticated;

-- ------------------------------------------------- 4. Private helpers
-- Not in an API-exposed schema, so clients cannot call them directly.

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

-- Test accounts the website hides everywhere (lib/email.ts isDeliverable).
create or replace function app_private.is_test_email(p_email text)
returns boolean language sql immutable as $$
  select coalesce(p_email like '%@nflsurvivor.internal', false)
$$;

create or replace function app_private.my_player_ids()
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(player_id), '{}') from public.player_accounts where user_id = auth.uid()
$$;

-- lib/deadline.ts slateDeadline(): cached locks_at, else the earliest
-- announced tip. A day with only TBD tips has no lock yet.
create or replace function app_private.slate_lock_time(p_slate_id uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select coalesce(
    s.locks_at,
    (select min(g.tip_time) from public.games g where g.slate_id = s.id and not g.time_tbd)
  )
  from public.slates s where s.id = p_slate_id
$$;

-- Picks become public exactly when their day locks (isPickRevealed). A game
-- already under way also counts, as on the website's Sweatboard.
create or replace function app_private.slate_is_revealed(p_slate_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(app_private.slate_lock_time(p_slate_id) <= now(), false)
      or exists (select 1 from public.games g where g.slate_id = p_slate_id and g.status_state <> 'pre')
$$;

-- lib/competition.ts normalizeRound(): one vocabulary for ESPN's headlines.
create or replace function app_private.normalize_round(p_label text)
returns text language sql immutable as $$
  select case lower(trim(p_label))
    when 'first four' then 'First Four'       when 'opening round' then 'First Four'
    when '1st round' then '1st Round'          when 'first round' then '1st Round'
    when 'round of 64' then '1st Round'
    when '2nd round' then '2nd Round'          when 'second round' then '2nd Round'
    when 'round of 32' then '2nd Round'
    when 'sweet 16' then 'Sweet 16'            when 'sweet sixteen' then 'Sweet 16'
    when 'regional semifinal' then 'Sweet 16'
    when 'elite 8' then 'Elite 8'              when 'elite eight' then 'Elite 8'
    when 'regional final' then 'Elite 8'
    when 'final four' then 'Final Four'        when 'national semifinal' then 'Final Four'
    when 'national championship' then 'National Championship'
    when 'championship' then 'National Championship'
    when 'championship game' then 'National Championship'
    else null end
$$;

create or replace function app_private.round_order(p_round text)
returns int language sql immutable as $$
  select coalesce(array_position(array['First Four','1st Round','2nd Round','Sweet 16','Elite 8','Final Four','National Championship'], p_round), 99)
$$;

-- roundForSlate(): the round most of the day's games carry; ties go to the
-- earlier round.
create or replace function app_private.round_for_slate(p_slate_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select r from (
    select app_private.normalize_round(g.round_label) as r, count(*) as c
    from public.games g where g.slate_id = p_slate_id
    group by 1
  ) x
  where r is not null
  order by c desc, app_private.round_order(r) asc
  limit 1
$$;

-- sharedRoundPickQuota(): null means one pick per day.
create or replace function app_private.shared_round_quota(p_mode text, p_frequency text, p_round text)
returns int language sql immutable as $$
  select case
    when p_mode <> 'march-madness' or p_round is null then null
    when p_round = 'Elite 8' or p_frequency = 'tournament-round' then
      case p_round when 'First Four' then 1 when 'Final Four' then 1 when 'National Championship' then 1 else 2 end
    else null end
$$;

-- ------------------------------------------------ 5. API functions (RPC)

create or replace function public.server_now()
returns timestamptz language sql stable as $$ select now() $$;

-- The signed-in user's entries.
create or replace function public.get_my_entries()
returns table (player_id uuid, full_name text, status text, elimination_slate int, elimination_reason text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.full_name, p.status, p.elimination_slate, p.elimination_reason
  from public.players p
  where p.id = any (app_private.my_player_ids())
  order by p.created_at
$$;

-- Field size, with test accounts excluded (dashboard.ts).
create or replace function public.get_pool_summary()
returns table (total_entries int, alive_entries int, paid_entries int)
language sql stable security definer set search_path = '' as $$
  select count(*)::int,
         count(*) filter (where status = 'alive')::int,
         count(*) filter (where paid)::int
  from public.players
  where auth.uid() is not null and not app_private.is_test_email(email)
$$;

-- Standings (lib/dashboard.ts). Today's teams appear only once the day is
-- revealed; before that everyone sees only whether an entry has picked.
-- Contact details and password hashes never leave the database.
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

-- One entry's pick history. Days that have not been revealed are withheld
-- unless the entry belongs to the caller.
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

-- Who is sweating a day (api/sweat/route.ts): alive entries plus those
-- eliminated on this day. Before the reveal, other entries show only
-- has_pick; the caller's own picks are always shown.
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

-- Make or change a pick. Mirrors src/app/api/picks/route.ts rule for rule,
-- using the database clock. The player row is locked for the duration, so
-- two taps (or a tap racing the auto-assign job) cannot both succeed.
create or replace function public.submit_pick(
  p_player_id uuid,
  p_slate_id uuid,
  p_team text,
  p_replace_pick_id uuid default null
)
returns table (pick_id uuid, team text, slate_id uuid, changed_from text)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_player public.players;
  v_slate public.slates;
  v_game public.games;
  v_lock timestamptz;
  v_mode text := 'regular-season';
  v_frequency text := 'every-game-day';
  v_round text;
  v_quota int;
  v_eligible uuid[];
  v_existing public.picks;
  v_count int;
  v_seed int;
  v_result public.picks;
begin
  if auth.uid() is null then
    raise exception 'Sign in to make a pick.' using errcode = '28000';
  end if;
  if not (p_player_id = any (app_private.my_player_ids())) then
    raise exception 'That entry does not belong to this account.' using errcode = '42501';
  end if;

  select * into v_player from public.players p where p.id = p_player_id for update;
  if v_player.id is null then
    raise exception 'Entry not found.';
  end if;
  if v_player.status = 'eliminated' then
    raise exception 'This entry has been eliminated.';
  end if;

  select * into v_slate from public.slates s where s.id = p_slate_id;
  if v_slate.id is null or not v_slate.is_active then
    raise exception 'Picks are only open for the current game day.';
  end if;

  p_team := upper(trim(p_team));
  select * into v_game from public.games g
    where g.slate_id = p_slate_id and (g.home_team = p_team or g.away_team = p_team)
    limit 1;
  if v_game.id is null then
    raise exception '% is not playing on this game day.', p_team;
  end if;

  v_lock := app_private.slate_lock_time(p_slate_id);
  if v_lock is not null and now() >= v_lock then
    raise exception 'Picks for today are locked. The first game has tipped off.';
  end if;

  select pl.competition_mode, pl.pick_frequency into v_mode, v_frequency
    from public.pools pl where pl.is_active limit 1;
  v_mode := coalesce(v_mode, 'regular-season');
  v_frequency := coalesce(v_frequency, 'every-game-day');

  if v_mode = 'march-madness' then
    v_round := app_private.round_for_slate(p_slate_id);
  end if;
  v_quota := app_private.shared_round_quota(v_mode, v_frequency, v_round);

  if v_quota is not null then
    select array_agg(s.id) into v_eligible from public.slates s
      where s.season_year = v_slate.season_year
        and app_private.round_for_slate(s.id) = v_round;
  else
    v_eligible := array[p_slate_id];
  end if;

  if p_replace_pick_id is not null then
    select * into v_existing from public.picks pk
      where pk.id = p_replace_pick_id and pk.player_id = p_player_id and pk.slate_id = p_slate_id;
    if v_existing.id is null then
      raise exception 'That pick cannot be changed on this game day.';
    end if;
  elsif v_quota is null then
    -- Daily pools keep the familiar replace-in-place behavior.
    select * into v_existing from public.picks pk
      where pk.player_id = p_player_id and pk.slate_id = p_slate_id
      order by pk.created_at limit 1;
  end if;

  select count(*) into v_count from public.picks pk
    where pk.player_id = p_player_id and pk.slate_id = any (v_eligible);
  if v_existing.id is null and v_count >= coalesce(v_quota, 1) then
    raise exception 'You already made all % required pick% for this %.',
      coalesce(v_quota, 1), case when coalesce(v_quota, 1) = 1 then '' else 's' end,
      case when v_quota is null then 'game day' else 'round' end
      using errcode = '23505';
  end if;

  if exists (select 1 from public.picks pk
             where pk.player_id = p_player_id and pk.team = p_team
               and pk.id is distinct from v_existing.id) then
    raise exception 'You already used % earlier in this pool.', p_team;
  end if;

  -- Seed snapshot for the tiebreak: tournament games only (seedForTeam).
  if v_game.round_label is not null then
    v_seed := case when v_game.home_team = p_team then v_game.home_seed else v_game.away_seed end;
  end if;

  if v_existing.id is not null and v_existing.team = p_team then
    return query select v_existing.id, v_existing.team, v_existing.slate_id, null::text;
    return;
  end if;

  begin
    if v_existing.id is not null then
      update public.picks pk
        set team = p_team, seed = v_seed, auto_assigned = false, submitted_by_admin = false
        where pk.id = v_existing.id
        returning * into v_result;
    else
      insert into public.picks (player_id, slate_id, team, seed, auto_assigned, submitted_by_admin)
        values (p_player_id, p_slate_id, p_team, v_seed, false, false)
        returning * into v_result;
    end if;
  exception when unique_violation then
    raise exception 'You already used % earlier in this pool.', p_team;
  end;

  insert into public.audit_log (event_type, actor, player_id, player_name, message, details)
  values (
    case when v_existing.id is null then 'pick-submitted' else 'pick-changed' end,
    'player', v_player.id, v_player.full_name,
    case when v_existing.id is null
      then format('%s picked %s for Slate %s (iOS app)', v_player.full_name, p_team, v_slate.slate_number)
      else format('%s changed Slate %s pick: %s → %s (iOS app)', v_player.full_name, v_slate.slate_number, v_existing.team, p_team)
    end,
    jsonb_build_object('slate_number', v_slate.slate_number, 'team', p_team,
                       'previous_team', v_existing.team, 'required_picks', coalesce(v_quota, 1), 'via', 'ios')
  );

  return query select v_result.id, v_result.team, v_result.slate_id, v_existing.team;
end;
$$;

-- Notification preferences for the signed-in user (defaults when unset).
create or replace function public.get_notification_preferences()
returns table (pick_reminders boolean, urgent_reminders boolean, results boolean, big_eliminations boolean, game_alerts boolean)
language sql stable security definer set search_path = '' as $$
  select coalesce(n.pick_reminders, true), coalesce(n.urgent_reminders, true), coalesce(n.results, true),
         coalesce(n.big_eliminations, true), coalesce(n.game_alerts, false)
  from (select auth.uid() as uid) me
  left join public.notification_preferences n on n.user_id = me.uid
  where me.uid is not null
$$;

create or replace function public.save_notification_preferences(
  p_pick_reminders boolean, p_urgent_reminders boolean, p_results boolean,
  p_big_eliminations boolean, p_game_alerts boolean
)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  insert into public.notification_preferences as n
    (user_id, pick_reminders, urgent_reminders, results, big_eliminations, game_alerts, updated_at)
  values (auth.uid(), p_pick_reminders, p_urgent_reminders, p_results, p_big_eliminations, p_game_alerts, now())
  on conflict (user_id) do update set
    pick_reminders = excluded.pick_reminders, urgent_reminders = excluded.urgent_reminders,
    results = excluded.results, big_eliminations = excluded.big_eliminations,
    game_alerts = excluded.game_alerts, updated_at = now();
end;
$$;

-- Push device registration, ready for APNs.
create or replace function public.register_push_device(p_token text, p_environment text, p_app_version text)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if p_token is null or length(p_token) not between 32 and 256 then raise exception 'Invalid device token.'; end if;
  insert into public.push_devices (user_id, token, environment, app_version)
  values (auth.uid(), p_token, coalesce(p_environment, 'production'), p_app_version)
  on conflict (token) do update set
    user_id = auth.uid(), environment = excluded.environment,
    app_version = excluded.app_version, last_seen_at = now();
end;
$$;

create or replace function public.unregister_push_device(p_token text)
returns void language sql volatile security definer set search_path = '' as $$
  delete from public.push_devices where token = p_token and user_id = auth.uid()
$$;

-- Service-role only: lets the mobile-sign-in Edge Function find an existing
-- Auth user by email (the admin API has no lookup by email).
create or replace function public.auth_user_id_by_email(p_email text)
returns uuid language sql stable security definer set search_path = '' as $$
  select id from auth.users where lower(email) = lower(p_email) limit 1
$$;

-- ------------------------------------------------------ 6. Function grants

do $$
declare f text;
begin
  foreach f in array array[
    'public.server_now()',
    'public.get_my_entries()',
    'public.get_pool_summary()',
    'public.get_standings()',
    'public.get_entry_picks(uuid)',
    'public.get_slate_picks(uuid)',
    'public.submit_pick(uuid, uuid, text, uuid)',
    'public.get_notification_preferences()',
    'public.save_notification_preferences(boolean, boolean, boolean, boolean, boolean)',
    'public.register_push_device(text, text, text)',
    'public.unregister_push_device(text)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$$;

revoke execute on function public.auth_user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.auth_user_id_by_email(text) to service_role;

grant usage on schema app_private to service_role;

notify pgrst, 'reload schema';
