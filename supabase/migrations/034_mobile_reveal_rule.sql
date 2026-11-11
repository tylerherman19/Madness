-- The mobile API (schema app_private, deployed from the native-ios branch and
-- not otherwise present in this repository) treated a day as revealed when any
-- game's ESPN status left 'pre'. A postponed or early-started game could then
-- expose every entry's pick before the lock. Reveal now follows the website's
-- rule only: the earlier of the stored lock and the first announced tip.
--
-- Guarded: a database built from this repository alone has no app_private
-- schema and skips this migration. Signatures and grants are unchanged.
begin;
do $migration$
begin
  if to_regprocedure('app_private.slate_lock_time(uuid)') is null
     or to_regprocedure('app_private.slate_is_revealed(uuid)') is null then
    return;
  end if;

  create or replace function app_private.slate_lock_time(p_slate_id uuid)
  returns timestamptz language sql stable security definer set search_path = '' as $fn$
    select least(
      s.locks_at,
      (select min(g.tip_time) from public.games g where g.slate_id = s.id and not g.time_tbd)
    )
    from public.slates s where s.id = p_slate_id
  $fn$;

  create or replace function app_private.slate_is_revealed(p_slate_id uuid)
  returns boolean language sql stable security definer set search_path = '' as $fn$
    select coalesce(app_private.slate_lock_time(p_slate_id) <= now(), false)
  $fn$;
end $migration$;
notify pgrst, 'reload schema';
commit;
