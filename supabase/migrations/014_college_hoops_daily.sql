-- Pivot from NFL weekly survivor to college basketball daily survivor.
--
-- The unit of play changes from a *week* to a *slate*: one calendar day
-- (Central) of games. Everything downstream keeps its shape — one pick per
-- player per slate, a loss eliminates, teams can't be reused — only the
-- period changes, plus the tournament fields the March Madness rules need.
--
-- This migration DROPS AND RECREATES games/picks/weeks rather than altering
-- them. That is safe here and only here: the database is empty (this project
-- was stood up fresh, no pool has ever been played on it). Do not copy this
-- pattern onto a database with real rows.

-- ---------------------------------------------------------------- public

drop table if exists picks cascade;
drop table if exists games cascade;
drop table if exists weeks cascade;
-- Also dropped so this file converges on the same end state when re-run
-- against a database where an earlier revision of it already landed.
drop table if exists slates cascade;
drop table if exists teams cascade;

-- One row per calendar day of games. `locks_at` is the first tip of the day,
-- cached at sync time: every pick for the slate locks at that instant, so the
-- pick page and the auto-assign cron don't each re-derive it from the games.
create table slates (
  id uuid primary key default gen_random_uuid(),
  -- Sequential day index within the season ("Day 12"). Ordering and labels
  -- key off this; slate_date is the calendar truth it is derived from.
  slate_number integer not null,
  slate_date date not null,
  season_year integer not null,
  is_active boolean not null default false,
  locks_at timestamptz,
  created_at timestamptz not null default now(),
  unique (slate_date, season_year),
  unique (slate_number, season_year)
);

-- Teams are discovered from the ESPN feed rather than hard-coded: ESPN's
-- /teams endpoint ignores the `groups` filter (it returns the same 100 teams
-- for every conference id), so the scoreboard is the only reliable source of
-- "who is in this conference". Conference realignment then costs nothing.
create table teams (
  abbr text primary key,
  display_name text not null,
  short_name text,
  logo text,
  conference text,
  updated_at timestamptz not null default now()
);

create table games (
  id uuid primary key default gen_random_uuid(),
  slate_id uuid not null references slates(id) on delete cascade,
  -- ESPN's event id. The unique constraint is what makes the five
  -- per-conference scoreboard calls safe to union: a non-conference matchup
  -- (Big Ten vs SEC) comes back from two of them and must land as one row.
  espn_event_id text not null unique,
  home_team text not null,
  away_team text not null,
  -- NCAA tournament seed, read from ESPN's curatedRank. Outside the
  -- tournament curatedRank carries the AP poll rank, and 99 for unranked —
  -- so treat these as "seed" only when round_label is set.
  home_seed integer,
  away_seed integer,
  tip_time timestamptz not null,
  -- From ESPN notes[0].headline, e.g. "1st Round", "Sweet 16", "Elite 8".
  -- Null for regular season games.
  round_label text,
  region text,
  venue text,
  tv text,
  -- ESPN status.type.state: pre | in | post
  status_state text not null default 'pre' check (status_state in ('pre', 'in', 'post')),
  period integer,
  display_clock text,
  home_score integer,
  away_score integer,
  result text not null default 'pending' check (result in ('home_win', 'away_win', 'tie', 'pending')),
  created_at timestamptz not null default now()
);

create table picks (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references players(id) on delete cascade,
  slate_id uuid not null references slates(id) on delete cascade,
  team text not null,
  -- Seed of the picked team, snapshotted when the pick is made. The endgame
  -- tiebreak is "highest sum of seeds taken", and a team's seed is only
  -- meaningful on the day it was picked, so it cannot be recomputed later.
  seed integer,
  auto_assigned boolean not null default false,
  submitted_by_admin boolean not null default false,
  created_at timestamptz not null default now(),
  unique (player_id, slate_id)
);

-- One team per player for the whole pool — the no-repeat rule.
create unique index picks_unique_team_per_player on picks (player_id, team);

create index picks_player_id_idx on picks (player_id);
create index picks_slate_id_idx on picks (slate_id);
create index games_slate_id_idx on games (slate_id);
create index games_tip_time_idx on games (tip_time);

-- At most one active slate, matching the old one-active-week guarantee.
create unique index slates_one_active_idx on slates (is_active) where is_active;

alter table slates disable row level security;
alter table teams disable row level security;
alter table games disable row level security;
alter table picks disable row level security;

-- Elimination is recorded against the slate index, same shape as before.
-- Written as drop/add rather than a rename so the file converges on the same
-- end state whether it runs on a fresh 001-013 database or a partially
-- migrated one. Destructive, like the rest of this migration.
alter table players drop column if exists elimination_week;
alter table players drop column if exists elimination_slate_date;
alter table players add column if not exists elimination_slate integer;

-- --------------------------------------------------------------- sandbox
-- Test Mode runs against a mirror of the schema in `sandbox`. Every change
-- above has to land here too or the sandbox drifts out of sync with prod.

drop table if exists sandbox.picks cascade;
drop table if exists sandbox.games cascade;
drop table if exists sandbox.weeks cascade;
drop table if exists sandbox.slates cascade;
drop table if exists sandbox.teams cascade;

create table sandbox.slates (
  id uuid primary key default gen_random_uuid(),
  slate_number integer not null,
  slate_date date not null,
  season_year integer not null,
  is_active boolean not null default false,
  locks_at timestamptz,
  created_at timestamptz not null default now(),
  unique (slate_date, season_year),
  unique (slate_number, season_year)
);

create table sandbox.teams (
  abbr text primary key,
  display_name text not null,
  short_name text,
  logo text,
  conference text,
  updated_at timestamptz not null default now()
);

create table sandbox.games (
  id uuid primary key default gen_random_uuid(),
  slate_id uuid not null references sandbox.slates(id) on delete cascade,
  espn_event_id text not null unique,
  home_team text not null,
  away_team text not null,
  home_seed integer,
  away_seed integer,
  tip_time timestamptz not null,
  round_label text,
  region text,
  venue text,
  tv text,
  status_state text not null default 'pre' check (status_state in ('pre', 'in', 'post')),
  period integer,
  display_clock text,
  home_score integer,
  away_score integer,
  result text not null default 'pending' check (result in ('home_win', 'away_win', 'tie', 'pending')),
  created_at timestamptz not null default now()
);

create table sandbox.picks (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references sandbox.players(id) on delete cascade,
  slate_id uuid not null references sandbox.slates(id) on delete cascade,
  team text not null,
  seed integer,
  auto_assigned boolean not null default false,
  submitted_by_admin boolean not null default false,
  created_at timestamptz not null default now(),
  unique (player_id, slate_id)
);

create unique index sandbox_picks_unique_team_per_player on sandbox.picks (player_id, team);
create index sandbox_picks_player_id_idx on sandbox.picks (player_id);
create index sandbox_picks_slate_id_idx on sandbox.picks (slate_id);
create index sandbox_games_slate_id_idx on sandbox.games (slate_id);
create index sandbox_games_tip_time_idx on sandbox.games (tip_time);
create unique index sandbox_slates_one_active_idx on sandbox.slates (is_active) where is_active;

alter table sandbox.slates disable row level security;
alter table sandbox.teams disable row level security;
alter table sandbox.games disable row level security;
alter table sandbox.picks disable row level security;

alter table sandbox.players drop column if exists elimination_week;
alter table sandbox.players drop column if exists elimination_slate_date;
alter table sandbox.players add column if not exists elimination_slate integer;

-- The sandbox clock table survives untouched (010); Test Mode still drives
-- "now" from it, which is how a slate can be replayed on demand.
