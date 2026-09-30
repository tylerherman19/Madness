-- Turn row-level security back on for the pool's core tables.
--
-- 014 (college hoops pivot) and 017 (pools) created their tables with RLS
-- *disabled*, undoing the posture 002 set: with RLS off, anyone holding the
-- project's anon key — which Supabase treats as public — can read every
-- pick before it locks and insert, change or delete picks, games and slates
-- straight through the REST API.
--
-- The app only ever talks to the database with the service role key, which
-- bypasses RLS, so no policies are needed: enabling RLS with none simply
-- denies the anon and authenticated roles. Safe to re-run.

alter table if exists public.slates enable row level security;
alter table if exists public.teams enable row level security;
alter table if exists public.games enable row level security;
alter table if exists public.picks enable row level security;
alter table if exists public.pools enable row level security;
alter table if exists public.players enable row level security;
alter table if exists public.rate_limits enable row level security;
alter table if exists public.audit_log enable row level security;

-- Belt and braces: the anon/authenticated roles have no business with these
-- tables at all, policy or not.
do $$
declare
  t text;
begin
  foreach t in array array['slates', 'teams', 'games', 'picks', 'pools'] loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke all on table public.%I from anon, authenticated', t);
    end if;
  end loop;
end
$$;

-- Test Mode's mirror. Only service_role is granted the sandbox schema (004),
-- but keep the two schemas on the same footing.
do $$
begin
  if to_regclass('sandbox.slates') is not null then
    alter table sandbox.slates enable row level security;
    alter table sandbox.teams enable row level security;
    alter table sandbox.games enable row level security;
    alter table sandbox.picks enable row level security;
  end if;
  if to_regclass('sandbox.pools') is not null then
    alter table sandbox.pools enable row level security;
  end if;
end
$$;
