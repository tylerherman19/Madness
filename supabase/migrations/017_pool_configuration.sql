-- Pool Configuration: the pool becomes a first-class, configurable object.
--
-- Until now the app was implicitly a single hard-coded pool whose rules lived
-- in code. MADNESS runs two different competitions off the same engine — a
-- regular-season college basketball survivor pool and an NCAA tournament one —
-- so the format has to be data an administrator owns, not a constant.
--
-- Competition mode is deliberately NOT derived from the calendar. March does
-- not make a pool a tournament pool; the administrator does.
--
-- Scoping: a pool row is the configuration for one competition. Several rows
-- may exist (Pool A on regular season, Pool B on the tournament, past seasons
-- kept for history) and exactly one is active — the one the app renders.
-- season_year is intentionally NOT unique: a regular-season pool and a
-- tournament pool both live inside season 2026. Slates are still keyed by
-- (slate_date, season_year); giving each pool its own slate stream is the
-- next step if two pools ever need to run concurrently, and nothing here
-- forecloses it.

create table if not exists pools (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'MADNESS',

  -- The format. Everything the UI adapts — terminology, seeds, rounds,
  -- bracket context, how the schedule and pick history are grouped — reads
  -- from this one value via lib/competition.ts.
  competition_mode text not null default 'regular-season'
    check (competition_mode in ('regular-season', 'march-madness')),

  -- Where the pool is in its own lifecycle. Orthogonal to competition_mode:
  -- a march-madness pool sits at 'upcoming' until Selection Sunday, and a
  -- regular-season pool is 'live' in January.
  status text not null default 'live'
    check (status in ('draft', 'upcoming', 'open', 'live', 'completed', 'archived')),

  season_year integer not null,

  -- How often a pick is required. 'every-game-day' is one pick per slate;
  -- 'tournament-round' spends the round's quota across that round's days.
  pick_frequency text not null default 'every-game-day'
    check (pick_frequency in ('every-game-day', 'weekends-only', 'tournament-round')),

  -- When picks lock. 'first-tip' locks the whole slate at its earliest tip —
  -- the rule the engine has always enforced. 'per-game' locks each pick at
  -- its own tip.
  pick_deadline_rule text not null default 'first-tip'
    check (pick_deadline_rule in ('first-tip', 'per-game')),

  -- 'once-per-pool' is the classic survivor no-repeat rule and is backed by
  -- the picks_unique_team_per_player index. The looser rules are stored so
  -- the UI can describe the pool honestly; relaxing the index is a separate,
  -- deliberate migration.
  team_reuse_rule text not null default 'once-per-pool'
    check (team_reuse_rule in ('once-per-pool', 'once-per-round', 'unlimited')),

  -- What happens to a player who misses the lock.
  auto_pick_behavior text not null default 'latest-game'
    check (auto_pick_behavior in ('latest-game', 'eliminate', 'none')),

  -- How the pool is settled when more than one player survives to the end.
  tiebreaker text not null default 'seed-total'
    check (tiebreaker in ('seed-total', 'most-survived', 'none')),

  starts_on date,

  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one active pool, same partial-index trick the slates table uses.
create unique index if not exists pools_one_active_idx on pools (is_active) where is_active;

alter table pools disable row level security;

-- Seed the pool that is already being played, so the app has configuration to
-- read on first boot. season_year comes from the active slate when there is
-- one; otherwise the newest season on record, otherwise the current year.
insert into pools (name, competition_mode, status, season_year, is_active)
select
  'MADNESS',
  'regular-season',
  'live',
  coalesce(
    (select season_year from slates where is_active limit 1),
    (select max(season_year) from slates),
    extract(year from now())::int
  ),
  true
where not exists (select 1 from pools);

-- --------------------------------------------------------------- sandbox
-- Test Mode mirrors the public schema; a rehearsal has to be able to exercise
-- both competition modes.

do $$
begin
  if to_regclass('sandbox.slates') is not null then
    create table if not exists sandbox.pools (like public.pools including all);

    insert into sandbox.pools (name, competition_mode, status, season_year, is_active)
    select
      'MADNESS (sandbox)',
      'regular-season',
      'live',
      coalesce(
        (select season_year from sandbox.slates where is_active limit 1),
        (select max(season_year) from sandbox.slates),
        extract(year from now())::int
      ),
      true
    where not exists (select 1 from sandbox.pools);

    alter table sandbox.pools disable row level security;
  end if;
end
$$;
