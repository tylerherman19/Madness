-- Commit a complete Elite Eight pair, or commit nothing. Team picks retain
-- their real game/slate identities for individual grading and audit receipts.
begin;
set local lock_timeout='5s';
do $migration$
declare s text;
begin
foreach s in array array['public','sandbox'] loop
 execute replace($sql$
 create or replace function __S__.enforce_march_2027_elite_pair() returns trigger
 language plpgsql set search_path=__S__,pg_catalog as $fn$
 declare d uuid; player uuid; anchor uuid; n integer;
 begin
  d:=case when tg_op='DELETE' then old.slate_id else new.slate_id end;
  player:=case when tg_op='DELETE' then old.player_id else new.player_id end;
  anchor:=__S__.march_2027_elite_anchor(d);
  if anchor is null then return null; end if;
  select count(*) into n from __S__.picks p where p.player_id=player and __S__.march_2027_elite_anchor(p.slate_id)=anchor;
  if n not in (0,2) then raise exception 'Both Elite Eight picks must be submitted together'; end if;
  return null;
 end $fn$;
 drop trigger if exists picks_march_2027_elite_pair on __S__.picks;
 create constraint trigger picks_march_2027_elite_pair after insert or update or delete on __S__.picks
 deferrable initially deferred for each row execute function __S__.enforce_march_2027_elite_pair();

 create or replace function __S__.save_march_2027_elite_pair(p_player uuid,p_request uuid,p_pair jsonb) returns jsonb
 language plpgsql set search_path=__S__,pg_catalog as $fn$
 declare prior __S__.pick_requests%rowtype; d uuid; anchor uuid; chosen jsonb; saved jsonb; result jsonb:='[]';
  old_id uuid; old_time timestamptz; lock_at timestamptz; effective_now timestamptz; existing integer;
 begin
  if p_request is null or jsonb_typeof(p_pair) is distinct from 'array' or jsonb_array_length(p_pair)<>2 then
   raise exception 'Choose exactly two Elite Eight teams before submitting';
  end if;
  if (select count(distinct x->>'team') from jsonb_array_elements(p_pair) x)<>2 then
   raise exception 'Choose two different Elite Eight teams';
  end if;
  perform 1 from __S__.players where id=p_player for update;
  if not found then raise exception 'Entry not found'; end if;
  select * into prior from __S__.pick_requests where player_id=p_player and request_id=p_request;
  if found then
   if prior.request is distinct from p_pair then raise exception 'Request ID reused with different selections'; end if;
   return prior.receipt;
  end if;
  -- Serialize pool rollover and the Saturday lock with other pick writes.
  perform 1 from __S__.pools where is_active and status in ('open','live') and season_year=2027 and competition_mode='march-madness' for share;
  if not found then raise exception 'Elite Eight picks are not open'; end if;
  anchor:=__S__.march_2027_elite_anchor((p_pair->0->>'slate_id')::uuid);
  if anchor is null or __S__.march_2027_elite_anchor((p_pair->1->>'slate_id')::uuid) is distinct from anchor
      or not __S__.march_2027_elite_ready(anchor) then raise exception 'Both Elite Eight schedules are required'; end if;
  perform 1 from __S__.slates where id in (anchor,(p_pair->0->>'slate_id')::uuid,(p_pair->1->>'slate_id')::uuid) order by id for share;
  if not exists(select 1 from __S__.slates where id=anchor and is_active) and not __S__.can_pick_early(p_player,anchor) then
   raise exception 'Elite Eight picks are not open yet for this entry';
  end if;
  lock_at:=__S__.march_2027_pick_deadline(anchor);
  effective_now:=clock_timestamp();
  if '__S__'='sandbox' then select coalesce(simulated_now,clock_timestamp()) into effective_now from sandbox.clock where id; end if;
  if lock_at is null or effective_now>=lock_at then raise exception 'Both Elite Eight picks locked at Saturday’s first tip'; end if;
  select count(*) into existing from __S__.picks p where p.player_id=p_player and __S__.march_2027_elite_anchor(p.slate_id)=anchor;
  if existing not in (0,2) or (select count(distinct x->>'pick_id') from jsonb_array_elements(p_pair) x)<>existing then
   raise exception 'Your saved Elite Eight picks changed. Refresh before submitting';
  end if;
  for chosen in select value from jsonb_array_elements(p_pair) loop
   d:=(chosen->>'slate_id')::uuid;
   old_id:=(chosen->>'pick_id')::uuid;
   old_time:=(chosen->>'expected')::timestamptz;
   saved:=__S__.save_pick(p_player,d,chosen->>'team',gen_random_uuid(),old_id,old_time);
   result:=result||jsonb_build_array(saved->'pick');
  end loop;
  effective_now:=clock_timestamp();
  if '__S__'='sandbox' then select coalesce(simulated_now,clock_timestamp()) into effective_now from sandbox.clock where id; end if;
  if effective_now>=lock_at then raise exception 'Both Elite Eight picks locked at Saturday’s first tip'; end if;
  saved:=jsonb_build_object('picks',result,'deadline',lock_at,'requestId',p_request);
  insert into __S__.pick_requests(player_id,request_id,request,receipt) values(p_player,p_request,p_pair,saved);
  return saved;
 end $fn$;
 revoke all on function __S__.enforce_march_2027_elite_pair(),__S__.save_march_2027_elite_pair(uuid,uuid,jsonb)
 from public,anon,authenticated;
 grant execute on function __S__.save_march_2027_elite_pair(uuid,uuid,jsonb) to service_role;
 $sql$,'__S__',s);
end loop;
end $migration$;
notify pgrst,'reload schema';
commit;
