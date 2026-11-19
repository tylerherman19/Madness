-- INT-06: a pick's seed is a tournament seed or nothing.
-- save_pick (025) copies games.home_seed/away_seed
-- unconditionally; outside the tournament ESPN fills those with AP ranks, so
-- regular-season picks stored ranks as "seeds". The published rules count
-- seeds only in the tournament (src/app/components/RulesSection.tsx), and the
-- application's legacy path already stores none outside it (deadline.ts
-- seedForTeam). One BEFORE trigger now applies that rule to every write path
-- (website, auto-assign, admin) without redefining save_pick.
-- Existing rows are left unchanged; no participant record is rewritten.
--
-- SEC-08: audit_log is append-only. Rows can be inserted, never updated or
-- deleted, by any role that goes through ordinary triggers (including the
-- service role the website uses). Restores (session_replication_role=replica)
-- and TRUNCATE in disposable test databases are unaffected by design.
--
-- Applies to public and, when present, sandbox. Idempotent and additive.
begin;
do $migration$
declare target text;
begin
  foreach target in array array['public', 'sandbox'] loop
    if to_regclass(target || '.picks') is null then continue; end if;

    if to_regprocedure(target || '.canonical_round(text)') is not null then
      execute replace($ddl$
        create or replace function __SCHEMA__.picks_tournament_seed_only() returns trigger
        language plpgsql set search_path = __SCHEMA__, pg_catalog as $fn$
        begin
          if new.seed is not null and not exists (
            select 1 from __SCHEMA__.games g
            where g.slate_id = new.slate_id and new.team in (g.home_team, g.away_team)
              and __SCHEMA__.canonical_round(g.round_label) is not null
          ) then
            new.seed := null;
          end if;
          return new;
        end $fn$;
        drop trigger if exists picks_tournament_seed_only on __SCHEMA__.picks;
        create trigger picks_tournament_seed_only before insert or update of seed, team, slate_id on __SCHEMA__.picks
          for each row execute function __SCHEMA__.picks_tournament_seed_only();
        revoke all on function __SCHEMA__.picks_tournament_seed_only() from public, anon, authenticated;
      $ddl$, '__SCHEMA__', target);
    end if;

    if to_regclass(target || '.audit_log') is not null then
      execute replace($ddl$
        create or replace function __SCHEMA__.audit_log_append_only() returns trigger
        language plpgsql set search_path = pg_catalog as $fn$
        begin
          raise exception 'audit_log is append-only' using errcode = '42501';
        end $fn$;
        drop trigger if exists audit_log_append_only on __SCHEMA__.audit_log;
        create trigger audit_log_append_only before update or delete on __SCHEMA__.audit_log
          for each row execute function __SCHEMA__.audit_log_append_only();
        revoke all on function __SCHEMA__.audit_log_append_only() from public, anon, authenticated;
      $ddl$, '__SCHEMA__', target);
    end if;
  end loop;
end $migration$;
commit;
