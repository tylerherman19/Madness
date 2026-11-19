-- A late Elite Eight auto-assignment must not get stuck.
--
-- The 2027 Elite Eight pair is assigned once, after Saturday's first tip, and
-- written one pick at a time. enforce_pick_integrity refuses any new pick for
-- an entry that already has a losing pick ("A previous pick lost"). When the
-- assignment run is late (an outage, waiting on AP rankings, the legacy daily
-- cron) and the pair's Saturday team has already lost, the first half is
-- written and the second half is refused, so the whole pair rolls back and
-- every retry fails the same way: the entry stays alive with no picks and
-- Sunday's assignment cannot run.
--
-- The two halves of the pair are one decision. For automatic and organizer
-- writes only, a loss by the other half of the same Elite Eight pair no
-- longer blocks the write. Grading then eliminates the entry as usual.
-- Players' own submissions are unaffected (they lock at Saturday's first
-- tip), and a loss in any earlier round still blocks every new pick.
--
-- Applies to public and, when present, sandbox. Idempotent: an already
-- patched function is left as it is; an unexpected definition aborts.
-- Rollback: on each schema, re-create the function from
-- replace(pg_get_functiondef(...), <replacement>, <needle>).
begin;
set local lock_timeout='5s';
do $migration$
declare s text; ddl text;
  needle constant text := 'where pp.player_id = new.player_id and pp.id <> new.id and not pp.loss_excused and';
  replacement text;
begin
foreach s in array array['public','sandbox'] loop
 if to_regprocedure(s||'.enforce_pick_integrity()') is null then continue; end if;
 if to_regprocedure(s||'.march_2027_elite_anchor(uuid)') is null then
  raise exception 'Apply migration 038 before 042 (%.march_2027_elite_anchor is missing)', s;
 end if;
 replacement := needle || replace(' not ((new.auto_assigned or new.submitted_by_admin)
          and coalesce(__S__.march_2027_elite_anchor(pp.slate_id) = __S__.march_2027_elite_anchor(new.slate_id), false)) and', '__S__', s);
 select pg_get_functiondef(to_regprocedure(s||'.enforce_pick_integrity()')) into ddl;
 if strpos(ddl, s||'.march_2027_elite_anchor(pp.slate_id)') > 0 then continue; end if;
 if strpos(ddl, needle) = 0 then
  raise exception 'Unexpected function definition: %.enforce_pick_integrity()', s;
 end if;
 execute replace(ddl, needle, replacement);
end loop;
end $migration$;
notify pgrst,'reload schema';
commit;
