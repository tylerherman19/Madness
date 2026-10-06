-- Data-integrity hardening. Additive and safe to re-run.
--
-- 1. updated_at on every mutable table, maintained by a trigger, so "when did
--    this change" has an answer without digging through the audit log.
-- 2. Case-insensitive email uniqueness. `players.email` was unique only as
--    typed; the app lower-cases every write, but the database didn't enforce
--    it, so a direct insert or an old row could create "A@x.com" next to
--    "a@x.com". Existing emails are normalised first. If two rows already
--    differ only by case the index creation fails — merge or rename one of
--    them, then re-run this file.
-- 3. Server-side bounds that mirror the API's validation (name length,
--    non-negative scores, sane seeds). Added NOT VALID: they bind every new
--    insert/update immediately but don't fail on legacy rows. Run
--    `alter table … validate constraint …` later once the data is clean.
-- 4. bump_rate_limit() is callable by service_role only (default PUBLIC
--    execute removed) and pins its search_path.
--
-- Every change is mirrored to the `sandbox` schema when it exists, so Test
-- Mode keeps matching production.

-- ------------------------------------------------------------ 1. updated_at

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.set_updated_at() from public, anon, authenticated;

do $$
declare
  s text;
  t text;
begin
  foreach s in array array['public', 'sandbox'] loop
    foreach t in array array['players', 'slates', 'games', 'picks', 'pools'] loop
      if to_regclass(format('%I.%I', s, t)) is not null then
        execute format('alter table %I.%I add column if not exists updated_at timestamptz not null default now()', s, t);
        execute format('drop trigger if exists set_updated_at on %I.%I', s, t);
        execute format(
          'create trigger set_updated_at before update on %I.%I for each row execute function public.set_updated_at()',
          s, t
        );
      end if;
    end loop;
  end loop;
end
$$;

-- ------------------------------------------- 2. case-insensitive email unique

do $$
declare
  s text;
begin
  foreach s in array array['public', 'sandbox'] loop
    if to_regclass(format('%I.players', s)) is not null then
      execute format('update %I.players set email = lower(btrim(email)) where email <> lower(btrim(email))', s);
      execute format('create unique index if not exists players_email_lower_key on %I.players (lower(email))', s);
    end if;
  end loop;
end
$$;

-- ------------------------------------------------------------ 3. CHECK bounds

do $$
declare
  s text;
begin
  foreach s in array array['public', 'sandbox'] loop
    if to_regclass(format('%I.players', s)) is not null
       and not exists (select 1 from pg_constraint where conname = 'players_full_name_length' and conrelid = format('%I.players', s)::regclass) then
      execute format(
        'alter table %I.players add constraint players_full_name_length check (char_length(btrim(full_name)) between 1 and 80) not valid',
        s
      );
    end if;
    if to_regclass(format('%I.players', s)) is not null
       and not exists (select 1 from pg_constraint where conname = 'players_email_length' and conrelid = format('%I.players', s)::regclass) then
      execute format(
        'alter table %I.players add constraint players_email_length check (char_length(email) between 3 and 254) not valid',
        s
      );
    end if;
    if to_regclass(format('%I.games', s)) is not null
       and not exists (select 1 from pg_constraint where conname = 'games_scores_nonnegative' and conrelid = format('%I.games', s)::regclass) then
      execute format(
        'alter table %I.games add constraint games_scores_nonnegative check (coalesce(home_score, 0) >= 0 and coalesce(away_score, 0) >= 0) not valid',
        s
      );
    end if;
    if to_regclass(format('%I.picks', s)) is not null
       and not exists (select 1 from pg_constraint where conname = 'picks_seed_range' and conrelid = format('%I.picks', s)::regclass) then
      execute format(
        'alter table %I.picks add constraint picks_seed_range check (seed is null or seed between 1 and 99) not valid',
        s
      );
    end if;
  end loop;
end
$$;

-- --------------------------------------------------- 4. rate-limit function

alter function public.bump_rate_limit(text, integer, integer) set search_path = public;
revoke execute on function public.bump_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.bump_rate_limit(text, integer, integer) to service_role;
