-- Track which game days have been fully graded.
--
-- Until now the nightly results job only ever looked at the active day. If
-- that one run failed (ESPN down at 3 AM, a timeout), the 6 AM advance moved
-- the pool on anyway and the missed day was never graded: everyone who lost
-- stayed alive and kept picking.
--
-- graded_at is set once a day's games are all decided and every pick on it
-- has been graded. The results job (lib/settle.ts) now syncs and grades every
-- day up to the active one that is still unsettled, so a missed night is
-- caught on the next run. A settled day is never re-graded automatically,
-- which keeps an administrator's manual restore on that day from being
-- undone by a later run.
--
-- The app runs without this column; the catch-up simply stays limited to the
-- active day until it is applied.

alter table public.slates
  add column if not exists graded_at timestamptz;

-- Days before the active one have already been handled by whatever ran at
-- the time. Mark them settled so applying this mid-season doesn't re-grade
-- (and re-eliminate) anything an administrator has since corrected.
update public.slates s
set graded_at = now()
where s.graded_at is null
  and exists (
    select 1 from public.slates a
    where a.is_active and s.slate_date < a.slate_date
  );

do $$
begin
  if to_regclass('sandbox.slates') is not null then
    alter table sandbox.slates
      add column if not exists graded_at timestamptz;

    update sandbox.slates s
    set graded_at = now()
    where s.graded_at is null
      and exists (
        select 1 from sandbox.slates a
        where a.is_active and s.slate_date < a.slate_date
      );
  end if;
end
$$;

-- Have PostgREST pick up the new column immediately.
notify pgrst, 'reload schema';
