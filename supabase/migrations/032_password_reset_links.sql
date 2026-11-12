-- Organizer-generated, one-time password reset links (no email).
--
-- The application generates 32 random bytes, stores only their SHA-256 hash in
-- players.pin_reset_token and shows the link once to the signed-in organizer.
-- After use the hash is kept with pin_reset_used_at set, so a second use is
-- recognised (and audited) instead of looking like an unknown link. Issuing a
-- new link overwrites the hash, which kills any earlier unused link.
--
-- consume_password_reset_link locks the matching player row: two concurrent
-- uses serialize on that lock and the second sees pin_reset_used_at already
-- set, so exactly one can change the password. Expired and reused links return
-- a status (never raise) so their audit rows commit. Audit rows never contain
-- the link, the token or its hash.
--
-- Additive and idempotent. Application code falls back to the pre-existing
-- columns when these functions are not installed yet.
begin;
do $migration$
declare target text;
begin
 foreach target in array array['public','sandbox'] loop
  execute replace($ddl$
   alter table __SCHEMA__.players add column if not exists pin_reset_used_at timestamptz;

   create or replace function __SCHEMA__.issue_password_reset_link(p_player uuid,p_hash text,p_expires timestamptz,p_actor text)
   returns jsonb language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
   declare p __SCHEMA__.players%rowtype; replaced boolean;
   begin
    if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' or p_expires is null
       or p_expires<=clock_timestamp() or p_expires>clock_timestamp()+interval '24 hours' then
     raise exception 'Invalid password reset link request';
    end if;
    select * into p from __SCHEMA__.players where id=p_player for update;
    if not found then return jsonb_build_object('status','not_found'); end if;
    replaced:=p.pin_reset_token is not null and p.pin_reset_used_at is null and coalesce(p.pin_reset_expires>clock_timestamp(),false);
    update __SCHEMA__.players set pin_reset_token=p_hash,pin_reset_expires=p_expires,pin_reset_used_at=null where id=p_player;
    -- A queued reset email (email delivery is disabled) would carry a dead link.
    update __SCHEMA__.notification_outbox set status='canceled',last_error='Superseded by an organizer reset link'
     where player_id=p_player and kind='password-reset' and status in ('held','pending');
    insert into __SCHEMA__.audit_log(event_type,actor,player_id,player_name,message,details)
    values('password-reset-link-created','admin',p.id,p.full_name,'Organizer created a one-time password reset link',
     jsonb_build_object('admin_session',p_actor,'expires_at',p_expires,'replaced_unused_link',replaced));
    return jsonb_build_object('status','ok','full_name',p.full_name,'expires_at',p_expires);
   end $fn$;

   create or replace function __SCHEMA__.consume_password_reset_link(p_hash text,p_password_hash text)
   returns jsonb language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
   declare p __SCHEMA__.players%rowtype;
   begin
    if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' or p_password_hash is null or length(p_password_hash)<20 then
     raise exception 'Invalid password reset request';
    end if;
    select * into p from __SCHEMA__.players where pin_reset_token=p_hash order by id limit 1 for update;
    -- Unknown links are not audited: they identify nobody and would let anyone fill the log.
    if not found then return jsonb_build_object('status','invalid'); end if;
    if p.pin_reset_used_at is not null then
     insert into __SCHEMA__.audit_log(event_type,actor,player_id,player_name,message,details)
     values('password-reset-link-reused','player',p.id,p.full_name,'An already used password reset link was tried again',jsonb_build_object('used_at',p.pin_reset_used_at));
     return jsonb_build_object('status','used');
    end if;
    if p.pin_reset_expires is null or p.pin_reset_expires<=clock_timestamp() then
     insert into __SCHEMA__.audit_log(event_type,actor,player_id,player_name,message,details)
     values('password-reset-link-expired','player',p.id,p.full_name,'An expired password reset link was tried',jsonb_build_object('expired_at',p.pin_reset_expires));
     return jsonb_build_object('status','expired');
    end if;
    -- Changing pin_hash also invalidates every existing session of this player
    -- (sessions carry an HMAC of the hash); other players are untouched.
    update __SCHEMA__.players set pin_hash=p_password_hash,pin_reset_used_at=clock_timestamp() where id=p.id;
    update __SCHEMA__.notification_outbox set status='canceled',last_error='Reset link used'
     where player_id=p.id and kind='password-reset' and status in ('held','pending');
    insert into __SCHEMA__.audit_log(event_type,actor,player_id,player_name,message,details)
    values('password-reset','player',p.id,p.full_name,p.full_name||' changed their password using a reset link',jsonb_build_object('method','organizer-link'));
    return jsonb_build_object('status','ok','player_id',p.id,'full_name',p.full_name);
   end $fn$;

   revoke all on function __SCHEMA__.issue_password_reset_link(uuid,text,timestamptz,text) from public,anon,authenticated;
   grant execute on function __SCHEMA__.issue_password_reset_link(uuid,text,timestamptz,text) to service_role;
   revoke all on function __SCHEMA__.consume_password_reset_link(text,text) from public,anon,authenticated;
   grant execute on function __SCHEMA__.consume_password_reset_link(text,text) to service_role;
  $ddl$, '__SCHEMA__', target);
 end loop;
end $migration$;
notify pgrst,'reload schema';
commit;
