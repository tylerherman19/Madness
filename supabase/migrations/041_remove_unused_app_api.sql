-- Remove the unused signed-in API layer from production.
--
-- An earlier, never-shipped client added a set of SECURITY DEFINER functions
-- that signed-in Supabase Auth users could call directly (pick submission,
-- standings and pick reads, notification and device settings), a private
-- helper schema, three tables and read policies on the schedule tables. No
-- client uses them, and the website never did: it talks to the database only
-- through the server with the service-role key. Left in place they are extra
-- attack surface, and their pick function does not know the 2027 rules
-- (for example the Elite Eight pair), so it could save a pick the website
-- would refuse.
--
-- Everything here is guarded with IF EXISTS: on a database built from this
-- repository it does nothing. Row-level security stays ON for every table.
-- Rollback: none needed for the website. The removed objects held no contest
-- data (entries, picks and results are untouched).
begin;
set local lock_timeout = '5s';

drop function if exists public.server_now();
drop function if exists public.get_my_entries();
drop function if exists public.get_pool_summary();
drop function if exists public.get_standings();
drop function if exists public.get_entry_picks(uuid);
drop function if exists public.get_slate_picks(uuid);
drop function if exists public.submit_pick(uuid, uuid, text, uuid);
drop function if exists public.get_notification_preferences();
drop function if exists public.save_notification_preferences(boolean, boolean, boolean, boolean, boolean);
drop function if exists public.register_push_device(text, text, text);
drop function if exists public.unregister_push_device(text);
drop function if exists public.auth_user_id_by_email(text);

drop table if exists public.push_devices;
drop table if exists public.notification_preferences;
drop table if exists public.player_accounts;

drop schema if exists app_private cascade;

-- Signed-in API users no longer read the schedule tables directly. The
-- service role (the website) bypasses row-level security and is unaffected.
do $$
declare t text;
begin
  foreach t in array array['slates', 'games', 'teams', 'pools'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists %I on public.%I', 'Signed-in users read ' || t, t);
      execute format('revoke all on public.%I from anon, authenticated', t);
    end if;
  end loop;
end
$$;

notify pgrst, 'reload schema';
commit;
