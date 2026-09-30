-- Per-slate bookkeeping for two jobs that now run off ordinary page traffic.
--
-- auto_assign_claimed_at / auto_assign_completed_at
--   Missed picks are now filled in minutes after a slate's first tip,
--   triggered from requests the site serves anyway (lib/autoAssign.ts), with
--   the daily cron as a backstop. Several requests can notice the lock at
--   once, so a run first claims the slate through claim_slate_auto_assign()
--   below — one conditional UPDATE, a 10-minute lease — and records
--   auto_assign_completed_at when the slate is fully handled so later
--   requests stop trying. Until this migration runs, the lazy trigger stays
--   off and only the cron assigns picks.
--
-- synced_at
--   Set whenever a day is synced from ESPN as the requested date. The pick
--   page reuses a next day synced in the last ten minutes instead of
--   re-syncing it on every view (lib/pickWindow.ts).

alter table public.slates
  add column if not exists synced_at timestamptz,
  add column if not exists auto_assign_claimed_at timestamptz,
  add column if not exists auto_assign_completed_at timestamptz;

do $$
begin
  if to_regclass('sandbox.slates') is not null then
    alter table sandbox.slates
      add column if not exists synced_at timestamptz,
      add column if not exists auto_assign_claimed_at timestamptz,
      add column if not exists auto_assign_completed_at timestamptz;
  end if;
end
$$;

-- The claim is a function rather than a filtered PATCH: PostgREST re-applies
-- an UPDATE's filters to the rows it returns, so "set claimed_at where it is
-- null or stale" would read back as zero rows even when it succeeded. Inside
-- one statement, Postgres re-checks the WHERE under the row lock, so exactly
-- one concurrent caller gets true.
create or replace function public.claim_slate_auto_assign(p_slate_id uuid, p_lease_seconds integer default 600)
returns boolean
language sql
as $$
  with claimed as (
    update public.slates
    set auto_assign_claimed_at = now()
    where id = p_slate_id
      and (auto_assign_claimed_at is null
           or auto_assign_claimed_at < now() - make_interval(secs => p_lease_seconds))
    returning 1
  )
  select exists (select 1 from claimed)
$$;

revoke execute on function public.claim_slate_auto_assign(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_slate_auto_assign(uuid, integer) to service_role;

do $$
begin
  if to_regclass('sandbox.slates') is not null then
    create or replace function sandbox.claim_slate_auto_assign(p_slate_id uuid, p_lease_seconds integer default 600)
    returns boolean
    language sql
    as $fn$
      with claimed as (
        update sandbox.slates
        set auto_assign_claimed_at = now()
        where id = p_slate_id
          and (auto_assign_claimed_at is null
               or auto_assign_claimed_at < now() - make_interval(secs => p_lease_seconds))
        returning 1
      )
      select exists (select 1 from claimed)
    $fn$;
    revoke execute on function sandbox.claim_slate_auto_assign(uuid, integer) from public;
    grant execute on function sandbox.claim_slate_auto_assign(uuid, integer) to service_role;
  end if;
end
$$;

-- Have PostgREST pick up the new columns and functions immediately.
notify pgrst, 'reload schema';
