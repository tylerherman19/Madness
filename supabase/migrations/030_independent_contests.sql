-- Independent contests. Requires 001-029. Additive: no existing row is deleted.
--
-- A contest is a pools row; exactly one is active. Every entry (players row)
-- belongs to exactly one contest and every pick carries its entry's contest.
-- Starting March Madness now archives the old contest and opens a new one
-- without deleting anything; the same email may hold one entry per contest.
-- Slates and games remain one shared schedule. Gameplay functions only see
-- the active contest's entries; archived entries are never graded, restored,
-- assigned or reminded because of activity in the active contest.
--
-- Deleting an archived contest is a separate, guarded function that writes a
-- full snapshot to contest_archives first.
begin;
do $migration$
declare target text; ddl text; con record; email_attnum int2;
begin
 foreach target in array array['public','sandbox'] loop
  if to_regclass(format('%I.picks',target)) is null or to_regclass(format('%I.pools',target)) is null then continue; end if;
  ddl := $schema$
alter table __SCHEMA__.pools add column if not exists ended_on date;

-- A database with entries must always have a contest to hold them.
insert into __SCHEMA__.pools(name, competition_mode, status, season_year, is_active)
select 'MADNESS', 'regular-season', 'live',
  coalesce((select season_year from __SCHEMA__.slates where is_active limit 1), (select max(season_year) from __SCHEMA__.slates), extract(year from now())::int), true
where not exists (select 1 from __SCHEMA__.pools);

-- The contest a new entry joins when none is named: the active one, else the
-- most recent (also the backfill rule for rows that predate this migration and
-- for restores of pre-030 backups, which run with triggers disabled).
create or replace function __SCHEMA__.contest_entry_pool() returns uuid
language sql stable set search_path=__SCHEMA__,pg_catalog as $fn$
 select id from __SCHEMA__.pools order by is_active desc, created_at desc, id desc limit 1
$fn$;

alter table __SCHEMA__.players add column if not exists pool_id uuid;
alter table __SCHEMA__.players disable trigger user;
update __SCHEMA__.players set pool_id = __SCHEMA__.contest_entry_pool() where pool_id is null;
alter table __SCHEMA__.players enable trigger user;
alter table __SCHEMA__.players alter column pool_id set default __SCHEMA__.contest_entry_pool();
alter table __SCHEMA__.players alter column pool_id set not null;
alter table __SCHEMA__.players drop constraint if exists players_pool_fk;
alter table __SCHEMA__.players add constraint players_pool_fk foreign key (pool_id) references __SCHEMA__.pools(id);
create unique index if not exists players_id_pool_unique on __SCHEMA__.players (id, pool_id);
create index if not exists players_pool_status_idx on __SCHEMA__.players (pool_id, status);
-- Per-contest email uniqueness. The old global constraints are dropped below,
-- only after this index exists.
create unique index if not exists players_contest_email_unique on __SCHEMA__.players (pool_id, lower(btrim(email)));

alter table __SCHEMA__.picks add column if not exists pool_id uuid;
-- Backfill without firing pick integrity/audit/revision triggers: legacy rows
-- may belong to eliminated entries on locked days and must not be re-validated.
alter table __SCHEMA__.picks disable trigger user;
update __SCHEMA__.picks pp set pool_id = e.pool_id from __SCHEMA__.players e
 where e.id = pp.player_id and pp.pool_id is distinct from e.pool_id;
alter table __SCHEMA__.picks enable trigger user;
alter table __SCHEMA__.picks alter column pool_id set default __SCHEMA__.contest_entry_pool();
alter table __SCHEMA__.picks alter column pool_id set not null;
-- The hard guarantee: a pick's contest is its entry's contest.
alter table __SCHEMA__.picks drop constraint if exists picks_entry_pool_fk;
alter table __SCHEMA__.picks add constraint picks_entry_pool_fk foreign key (player_id, pool_id)
 references __SCHEMA__.players (id, pool_id) on delete cascade;
create index if not exists picks_pool_slate_idx on __SCHEMA__.picks (pool_id, slate_id);

-- picks.pool_id is always derived from the entry, never trusted from a client.
create or replace function __SCHEMA__.scope_pick_to_entry() returns trigger
language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
begin
 new.pool_id := (select pool_id from __SCHEMA__.players where id = new.player_id);
 if new.pool_id is null then raise exception 'Player not found'; end if;
 return new;
end $fn$;
drop trigger if exists picks_00_contest on __SCHEMA__.picks;
create trigger picks_00_contest before insert or update of player_id, pool_id on __SCHEMA__.picks
 for each row execute function __SCHEMA__.scope_pick_to_entry();

-- Entries never move between contests, and new entries only join the active one.
create or replace function __SCHEMA__.guard_entry_contest() returns trigger
language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
begin
 if TG_OP = 'UPDATE' then
  if new.pool_id is distinct from old.pool_id then raise exception 'An entry cannot move between contests'; end if;
  return new;
 end if;
 if not exists (select 1 from __SCHEMA__.pools where id = new.pool_id and is_active) then
  raise exception 'New entries can only join the active contest';
 end if;
 return new;
end $fn$;
drop trigger if exists players_00_contest on __SCHEMA__.players;
create trigger players_00_contest before insert or update of pool_id on __SCHEMA__.players
 for each row execute function __SCHEMA__.guard_entry_contest();

-- 025: rules freeze per contest; archiving (status/is_active/ended_on) is not a rule change.
create or replace function __SCHEMA__.protect_frozen_rules() returns trigger language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
begin
 if exists(select 1 from __SCHEMA__.picks where pool_id=old.id) and exists(select 1 from __SCHEMA__.rule_versions where configuration->>'id'=old.id::text) and (to_jsonb(new)-array['updated_at','status','name','is_active','ended_on']) is distinct from (to_jsonb(old)-array['updated_at','status','name','is_active','ended_on']) then raise exception 'Contest rules are frozen; reviewed rule amendment required'; end if;
 return new;
end $fn$;

-- 025: a revision records the rule version of the pick's own contest.
create or replace function __SCHEMA__.record_pick_revision() returns trigger language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
declare rule_id uuid; notice_kind text;
begin
 select r.id into rule_id from __SCHEMA__.rule_versions r where r.configuration->>'id'=new.pool_id::text order by r.frozen_at desc,r.id limit 1;
 insert into __SCHEMA__.pick_revisions(pick_id,player_id,slate_id,version,previous_team,team,accepted_at,actor,origin,reason,rule_version)
 values(new.id,new.player_id,new.slate_id,new.version,case when TG_OP='UPDATE' then old.team end,new.team,new.updated_at,
 coalesce(nullif(current_setting('madness.actor',true),''),case when new.auto_assigned then 'assignment-worker' when new.submitted_by_admin then 'legacy-admin-service' else new.player_id::text end),
 case when new.auto_assigned then 'automatic' when new.submitted_by_admin then 'administrator' else 'manual' end,nullif(current_setting('madness.reason',true),''),rule_id);
 notice_kind:=case when new.auto_assigned then 'auto-pick' else 'pick-confirmation' end;
 insert into __SCHEMA__.notification_outbox(event_key,kind,player_id,recipient,payload,priority)
 select 'pick:'||new.id||':'||new.version,notice_kind,p.id,p.email,
 jsonb_build_object('player_id',p.id,'email',p.email,'name',p.full_name,'pick_id',new.id,'slate_id',new.slate_id,'team',new.team,'version',new.version,'accepted_at',new.updated_at),30 from __SCHEMA__.players p where p.id=new.player_id;
 return null;
end $fn$;

-- 025: rules come from the entry's own contest, which must be the active one.
create or replace function __SCHEMA__.enforce_pick_integrity()
      returns trigger language plpgsql set search_path = __SCHEMA__, pg_catalog as $fn$
      declare p __SCHEMA__.players%rowtype; s __SCHEMA__.slates%rowtype;
        cfg __SCHEMA__.pools%rowtype; lock_at timestamptz; first_tip timestamptz;
        round_name text; quota integer := 1; period_ids uuid[]; n integer;
        effective_now timestamptz;
      begin
        if TG_OP = 'UPDATE' and new.loss_excused is distinct from old.loss_excused
          and (to_jsonb(new) - 'loss_excused') = (to_jsonb(old) - 'loss_excused') then return new; end if;
        if TG_OP = 'UPDATE' and (new.player_id <> old.player_id or new.slate_id <> old.slate_id) then
          raise exception 'Pick ownership and period are immutable';
        end if;
        select * into p from __SCHEMA__.players where id = new.player_id for update;
        if not found then raise exception 'Player not found'; end if;
        new.pool_id := p.pool_id;
        select * into cfg from __SCHEMA__.pools where id = p.pool_id for share;
        if not found or not cfg.is_active then raise exception 'This entry belongs to a contest that is no longer active'; end if;
        if cfg.pick_deadline_rule <> 'first-tip' or cfg.team_reuse_rule <> 'once-per-pool'
          or cfg.pick_frequency = 'weekends-only' then raise exception 'Competition rules unavailable or unsupported'; end if;
        select * into s from __SCHEMA__.slates where id = new.slate_id for share;
        if not found then raise exception 'Slate not found'; end if;
        if cfg.season_year<>s.season_year then raise exception 'This day is outside the active contest season'; end if;
        if cfg.starts_on is not null and s.slate_date < cfg.starts_on then raise exception 'This day is outside the active contest'; end if;
        if p.status <> 'alive' then raise exception 'You are eliminated'; end if;
        -- Pending grading must not make a previously losing entry eligible.
        if exists (select 1 from __SCHEMA__.picks pp join __SCHEMA__.games g on g.slate_id = pp.slate_id
          where pp.player_id = new.player_id and pp.id <> new.id and not pp.loss_excused and
          ((pp.team = g.home_team and g.result in ('away_win', 'tie')) or
           (pp.team = g.away_team and g.result in ('home_win', 'tie')))) then
          raise exception 'A previous pick lost; entry is ineligible';
        end if;
        select min(tip_time) into first_tip from __SCHEMA__.games where slate_id = s.id and not time_tbd;
        lock_at := least(s.locks_at, first_tip);
        effective_now := clock_timestamp();
        if '__SCHEMA__' = 'sandbox' and to_regclass('sandbox.clock') is not null then
          execute 'select coalesce(simulated_now, clock_timestamp()) from sandbox.clock where id = true' into effective_now;
        end if;
        if not new.auto_assigned and not new.submitted_by_admin then
          if not s.is_active and not __SCHEMA__.can_pick_early(new.player_id,s.id) then raise exception 'Pick period is not open'; end if;
          if lock_at is null or effective_now >= lock_at then raise exception 'Picks are locked or the deadline is unavailable'; end if;
          if not exists (select 1 from __SCHEMA__.games where slate_id = s.id and
            (home_team = new.team or away_team = new.team) and result = 'pending' and status_state = 'pre') then
            raise exception 'This team is unavailable';
          end if;
        end if;
        select __SCHEMA__.canonical_round(round_label) into round_name from __SCHEMA__.games where slate_id = s.id and
          (home_team = new.team or away_team = new.team) order by id limit 1;
        if not found then raise exception 'Team is not playing this slate'; end if;
        if cfg.competition_mode = 'march-madness' and round_name is null then
          raise exception 'Authoritative tournament round is unavailable';
        end if;
        period_ids := array[s.id];
        if cfg.competition_mode = 'march-madness' and round_name is not null and
          (cfg.pick_frequency = 'tournament-round' or round_name = 'Elite 8') then
          quota := case round_name when '1st Round' then 2 when '2nd Round' then 2
            when 'Sweet 16' then 2 when 'Elite 8' then 2 else 1 end;
          select array_agg(distinct ss.id) into period_ids from __SCHEMA__.slates ss
            join __SCHEMA__.games gg on gg.slate_id = ss.id
            where ss.season_year = s.season_year and __SCHEMA__.canonical_round(gg.round_label) = round_name;
        end if;
        select count(*) into n from __SCHEMA__.picks where player_id = p.id
          and slate_id = any(period_ids) and id <> new.id;
        if n >= quota then raise exception 'Pick quota reached'; end if;
        if exists (select 1 from __SCHEMA__.picks where player_id = p.id and team = new.team and id <> new.id) then
          raise exception 'Team already used';
        end if;
        effective_now := clock_timestamp();
        if '__SCHEMA__' = 'sandbox' then select coalesce(simulated_now,clock_timestamp()) into effective_now from sandbox.clock where id=true; end if;
        if not new.auto_assigned and not new.submitted_by_admin and (lock_at is null or effective_now>=lock_at) then raise exception 'Picks are locked or the deadline is unavailable'; end if;
        select g.id,case when g.home_team=new.team then g.home_team_id else g.away_team_id end into new.game_id,new.team_id from __SCHEMA__.games g where g.slate_id=new.slate_id and new.team in(g.home_team,g.away_team) order by g.id limit 1;
        if new.team_id is not null and exists(select 1 from __SCHEMA__.picks pp where pp.player_id=new.player_id and pp.team_id=new.team_id and pp.id<>new.id) then raise exception 'Team already used'; end if;
        if new.auto_assigned and nullif(current_setting('madness.assignment_token',true),'') is not null and not exists(select 1 from __SCHEMA__.slates ss where ss.id=new.slate_id and ss.assignment_token::text=current_setting('madness.assignment_token',true) and ss.auto_assign_claimed_at>clock_timestamp()-interval '4 minutes') then raise exception 'Assignment lease lost'; end if;
        new.version := case when TG_OP='INSERT' then 1 else old.version+1 end;
        new.updated_at := clock_timestamp();
        return new;
      end $fn$;

-- 023: only entries of the active contest can be restored.
create or replace function __SCHEMA__.restore_player(p_player_id uuid, p_reason text, p_admin_session text default null)
    returns void language plpgsql set search_path = __SCHEMA__, pg_catalog as $fn$
    declare previous __SCHEMA__.players%rowtype; excused uuid[];
    begin
      if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'A restoration reason is required'; end if;
      select * into previous from __SCHEMA__.players where id = p_player_id for update;
      if not found then raise exception 'Player not found'; end if;
      if not exists (select 1 from __SCHEMA__.pools where id = previous.pool_id and is_active) then
        raise exception 'This entry belongs to an archived contest and cannot be restored';
      end if;
      if previous.status <> 'eliminated' then raise exception 'Player is already alive'; end if;
      with changed as (
        update __SCHEMA__.picks pp set loss_excused = true
        where pp.player_id = p_player_id and not pp.loss_excused and exists (
          select 1 from __SCHEMA__.games g where g.slate_id = pp.slate_id and
          ((pp.team = g.home_team and g.result in ('away_win', 'tie')) or
           (pp.team = g.away_team and g.result in ('home_win', 'tie')))
        ) returning pp.id
      ) select array_agg(id) into excused from changed;
      update __SCHEMA__.players set status = 'alive', elimination_reason = null, elimination_slate = null where id = p_player_id;
      insert into __SCHEMA__.audit_log(event_type, actor, player_id, player_name, message, details)
      values ('player-updated', 'admin', p_player_id, previous.full_name, 'Admin restored ' || previous.full_name,
        jsonb_build_object('previous_status', previous.status, 'previous_reason', previous.elimination_reason,
          'previous_slate', previous.elimination_slate, 'status', 'alive', 'reason', p_reason,
          'excused_pick_ids', coalesce(excused, array[]::uuid[]), 'admin_session', p_admin_session));
      update __SCHEMA__.notification_outbox set status = 'review'
        where kind = 'elimination' and payload->>'player_id' = p_player_id::text and status = 'pending';
    end $fn$;

-- 023: grading never eliminates an entry outside the active contest.
create or replace function __SCHEMA__.grade_pick_loss(p_pick_id uuid, p_slate_number integer, p_reason text)
    returns boolean language plpgsql set search_path = __SCHEMA__, pg_catalog as $fn$
    declare owner_id uuid; entry __SCHEMA__.players%rowtype; chosen __SCHEMA__.picks%rowtype;
    begin
      select player_id into owner_id from __SCHEMA__.picks where id = p_pick_id;
      if not found then return false; end if;
      select * into entry from __SCHEMA__.players where id = owner_id for update;
      if not found or entry.status <> 'alive' then return false; end if;
      if not exists (select 1 from __SCHEMA__.pools where id = entry.pool_id and is_active) then return false; end if;
      select * into chosen from __SCHEMA__.picks where id = p_pick_id;
      if not found or chosen.loss_excused then return false; end if;
      if not exists (select 1 from __SCHEMA__.games g where g.slate_id = chosen.slate_id and
        ((chosen.team = g.home_team and g.result in ('away_win', 'tie')) or
         (chosen.team = g.away_team and g.result in ('home_win', 'tie')))) then return false; end if;
      update __SCHEMA__.players set status='eliminated', elimination_slate=p_slate_number, elimination_reason=p_reason where id=owner_id;
      insert into __SCHEMA__.audit_log(event_type, actor, player_id, player_name, message, details)
      values('player-eliminated', 'system', entry.id, entry.full_name, entry.full_name || ' eliminated — ' || p_reason,
        jsonb_build_object('pick_id', chosen.id, 'slate_number', p_slate_number, 'team', chosen.team));
      return true;
    end $fn$;

-- 023 (six-argument form): reminders only reach active-contest entries.
create or replace function __SCHEMA__.queue_pick_reminders(p_slate_id uuid, p_player_ids uuid[], p_period_ids uuid[],
      p_quota integer, p_deadline timestamptz, p_deadline_label text)
    returns integer language plpgsql set search_path = __SCHEMA__, pg_catalog as $fn$
    declare n integer; effective_now timestamptz := clock_timestamp(); actual_deadline timestamptz;
    begin
      if '__SCHEMA__' = 'sandbox' and to_regclass('sandbox.clock') is not null then
        execute 'select coalesce(simulated_now, clock_timestamp()) from sandbox.clock where id = true' into effective_now;
      end if;
      select least(s.locks_at, (select min(tip_time) from __SCHEMA__.games where slate_id = s.id and not time_tbd))
        into actual_deadline from __SCHEMA__.slates s where s.id = p_slate_id and s.is_active;
      if actual_deadline is null then return 0; end if;
      actual_deadline := least(actual_deadline, p_deadline);
      if actual_deadline is null or actual_deadline <= effective_now or actual_deadline > effective_now + interval '24 hours' then return 0; end if;
      insert into __SCHEMA__.notification_outbox(event_key, kind, payload)
      select 'reminder:' || p_slate_id || ':' || p.id, 'reminder',
        jsonb_build_object('player_id', p.id, 'email', p.email, 'name', p.full_name, 'slate_id', p_slate_id,
          'deadline', actual_deadline, 'deadline_label', p_deadline_label)
      from __SCHEMA__.players p where p.id = any(p_player_ids) and p.status = 'alive'
        and p.pool_id = (select id from __SCHEMA__.pools where is_active)
        and (select count(*) from __SCHEMA__.picks where player_id = p.id and slate_id = any(p_period_ids)) < p_quota
      on conflict(event_key) do nothing;
      get diagnostics n = row_count; return n;
    end $fn$;

-- 024 (seven-argument form, the one lib/reminders.ts calls with p_window).
create or replace function __SCHEMA__.queue_pick_reminders(p_slate_id uuid, p_player_ids uuid[], p_period_ids uuid[],
      p_quota integer, p_deadline timestamptz, p_deadline_label text, p_window text)
    returns integer language plpgsql set search_path = __SCHEMA__, pg_catalog as $fn$
    declare n integer; effective_now timestamptz := clock_timestamp(); actual_deadline timestamptz;
    begin
      if '__SCHEMA__' = 'sandbox' and to_regclass('sandbox.clock') is not null then
        execute 'select coalesce(simulated_now, clock_timestamp()) from sandbox.clock where id = true' into effective_now;
      end if;
      select least(s.locks_at, (select min(tip_time) from __SCHEMA__.games where slate_id = s.id and not time_tbd))
        into actual_deadline from __SCHEMA__.slates s where s.id = p_slate_id and s.is_active;
      if actual_deadline is null then return 0; end if;
      actual_deadline := least(actual_deadline, p_deadline);
      if actual_deadline is null or actual_deadline <= effective_now or actual_deadline > effective_now + interval '24 hours' then return 0; end if;
      insert into __SCHEMA__.notification_outbox(event_key, kind, payload)
      select 'reminder:' || p_slate_id || ':' || p.id || ':' || p_window, 'reminder',
        jsonb_build_object('player_id', p.id, 'email', p.email, 'name', p.full_name, 'slate_id', p_slate_id,
          'deadline', actual_deadline, 'deadline_label', p_deadline_label)
      from __SCHEMA__.players p where p.id = any(p_player_ids) and p.status = 'alive' and p.notifications_enabled
        and p.pool_id = (select id from __SCHEMA__.pools where is_active)
        and (select count(*) from __SCHEMA__.picks where player_id = p.id and slate_id = any(p_period_ids)) < p_quota
      on conflict(event_key) do nothing;
      get diagnostics n = row_count; return n;
    end $fn$;

-- 024: the grading gate only considers the active contest's entries.
create or replace function __SCHEMA__.activate_slate_checked(p_expected uuid,p_next uuid)
   returns void language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
   begin
    perform pg_advisory_xact_lock(hashtextextended('__SCHEMA__.active-slate',0));
    if not exists(select 1 from __SCHEMA__.slates where id=p_expected and is_active and auto_assign_completed_at is not null) then raise exception 'Active day changed or assignments incomplete'; end if;
    if not exists(select 1 from __SCHEMA__.games where slate_id=p_expected)
      or exists(select 1 from __SCHEMA__.games where slate_id=p_expected and result='pending') then raise exception 'Results incomplete'; end if;
    if exists(select 1 from __SCHEMA__.picks pp join __SCHEMA__.players p on p.id=pp.player_id join __SCHEMA__.games g on g.slate_id=pp.slate_id
      where pp.slate_id=p_expected and p.status='alive' and not pp.loss_excused and p.pool_id=(select id from __SCHEMA__.pools where is_active) and
       ((pp.team=g.home_team and g.result in ('away_win','tie')) or (pp.team=g.away_team and g.result in ('home_win','tie')))) then raise exception 'Grading incomplete'; end if;
    if not exists(select 1 from __SCHEMA__.slates a join __SCHEMA__.slates b on b.id=p_next where a.id=p_expected and b.slate_date>a.slate_date and a.season_year=b.season_year) then raise exception 'Invalid next day'; end if;
    perform __SCHEMA__.activate_slate(p_next);
   end $fn$;

-- 025: automatic assignment and missed-deadline elimination only touch active-contest entries.
create or replace function __SCHEMA__.apply_assignment(p_slate_id uuid,p_token uuid,p_player_id uuid,p_teams jsonb,p_reason text default null,p_period_ids uuid[] default null,p_expected_count integer default 0)
   returns void language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
   declare s __SCHEMA__.slates%rowtype; t jsonb;
   begin
    perform 1 from __SCHEMA__.players where id=p_player_id for update;
    if not exists(select 1 from __SCHEMA__.players e join __SCHEMA__.pools c on c.id=e.pool_id and c.is_active where e.id=p_player_id) then raise exception 'Entry is not in the active contest'; end if;
    select * into s from __SCHEMA__.slates where id=p_slate_id for share;
    if not found or not s.is_active or s.assignment_token is distinct from p_token or s.auto_assign_claimed_at<clock_timestamp()-interval '4 minutes' then raise exception 'Assignment lease lost'; end if;
    perform set_config('madness.assignment_token',p_token::text,true);
    if (select count(*) from __SCHEMA__.picks where player_id=p_player_id and slate_id=any(coalesce(p_period_ids,array[p_slate_id])))<>p_expected_count then raise exception 'Pick state changed; retry'; end if;
    if p_reason is not null then
     update __SCHEMA__.players set status='eliminated',elimination_slate=s.slate_number,elimination_reason=p_reason where id=p_player_id and status='alive';
    else
     for t in select value from jsonb_array_elements(p_teams) loop
      insert into __SCHEMA__.picks(player_id,slate_id,team,seed,auto_assigned,submitted_by_admin)
       values(p_player_id,p_slate_id,t->>'team',(t->>'seed')::integer,true,false);
     end loop;
    end if;
   end $fn$;

-- 025: an announcement audience is the campaign's own contest.
create or replace function __SCHEMA__.expand_campaign(p_id uuid,p_limit integer default 200) returns integer language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
declare c __SCHEMA__.email_campaigns%rowtype; p record; nid uuid; total integer:=0;
begin
 select * into c from __SCHEMA__.email_campaigns where id=p_id for update skip locked;
 if not found or c.status<>'expanding' then return 0; end if;
 if c.contest_id is distinct from (select id from __SCHEMA__.pools where is_active) then update __SCHEMA__.email_campaigns set status='canceled' where id=c.id;return 0;end if;
 for p in select * from __SCHEMA__.players where pool_id=c.contest_id and (c.cursor_id is null or id>c.cursor_id) and created_at<=c.audience_cutoff order by id limit least(500,greatest(1,p_limit)) loop
  if (c.audience='all' or c.audience='selected' and p.id=any(c.selected_ids) or c.audience='alive' and p.status='alive' or c.audience='unpicked' and p.status='alive' and (select count(*) from __SCHEMA__.picks where player_id=p.id and slate_id=any(c.period_ids))<c.quota) then
   insert into __SCHEMA__.notification_outbox(event_key,kind,player_id,recipient,campaign_id,payload,priority,expires_at) values('campaign:'||c.id||':'||p.id,'announcement',p.id,p.email,c.id,jsonb_build_object('player_id',p.id,'email',p.email,'name',p.full_name,'subject',c.subject,'message',c.message),80,c.expires_at) on conflict(event_key) do update set event_key=excluded.event_key returning id into nid;
   insert into __SCHEMA__.campaign_recipients values(c.id,p.id,nid) on conflict do nothing;
  end if;
  update __SCHEMA__.email_campaigns set cursor_id=p.id where id=c.id;
  total:=total+1;
 end loop;
 if total<least(500,greatest(1,p_limit)) then update __SCHEMA__.email_campaigns set status='expanded' where id=c.id; end if;
 return total;
end $fn$;

-- 026: counts describe the active contest only.
create or replace function __SCHEMA__.contest_counts() returns jsonb language plpgsql stable set search_path=__SCHEMA__,pg_catalog as $fn$
declare requirement jsonb; ids uuid[]; quota integer; result jsonb; active_id uuid;
begin
 active_id:=(select id from __SCHEMA__.pools where is_active);
 requirement:=__SCHEMA__.active_pick_requirement();
 select array_agg(value::uuid) into ids from jsonb_array_elements_text(requirement->'period_ids');
 quota:=(requirement->>'quota')::integer;
 select jsonb_build_object('players',count(*),'alive',count(*) filter(where p.status='alive'),'eliminated',count(*) filter(where p.status='eliminated'),'paid',count(*) filter(where p.paid),'unpaid',count(*) filter(where not p.paid),
 'complete',count(*) filter(where p.status='alive' and coalesce(n,0)>=quota),'partial',count(*) filter(where p.status='alive' and n>0 and n<quota),'missing',count(*) filter(where p.status='alive' and coalesce(n,0)=0),
 'unpicked',count(*) filter(where p.status='alive' and coalesce(n,0)<quota)) into result
 from __SCHEMA__.players p left join(select player_id,count(*) n from __SCHEMA__.picks where slate_id=any(ids) and pool_id=active_id group by player_id) counts on counts.player_id=p.id
 where p.pool_id=active_id;
 return result||jsonb_build_object('requirement',requirement,'pool_id',active_id);
end $fn$;

-- 026: reconciliation findings about grading/season scope are per active contest.
create or replace function __SCHEMA__.reconcile_contest() returns jsonb language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
declare result jsonb; counts jsonb; missing_receipts bigint; ungraded bigint; expired_leases bigint; active_days bigint; missing_audience bigint; cfg __SCHEMA__.pools%rowtype;
begin
 counts:=__SCHEMA__.contest_counts();
 select * into cfg from __SCHEMA__.pools where is_active;
 select count(*) into missing_receipts from __SCHEMA__.pick_revisions r where not exists(select 1 from __SCHEMA__.notification_outbox n where n.event_key='pick:'||r.pick_id||':'||r.version);
 select count(distinct p.id) into ungraded from __SCHEMA__.picks p join __SCHEMA__.players e on e.id=p.player_id join __SCHEMA__.games g on g.slate_id=p.slate_id where e.status='alive' and e.pool_id=cfg.id and not p.loss_excused and ((p.team=g.home_team and g.result in ('away_win','tie')) or(p.team=g.away_team and g.result in ('home_win','tie')));
 select count(*) into expired_leases from __SCHEMA__.operation_runs where status='running' and lease_until<clock_timestamp();
 expired_leases:=expired_leases+(select count(*) from __SCHEMA__.notification_outbox where status='processing' and lease_until<clock_timestamp());
 select count(*) into active_days from __SCHEMA__.slates where is_active;
 select count(*) into missing_audience from __SCHEMA__.campaign_recipients r left join __SCHEMA__.notification_outbox n on n.id=r.notification_id where n.id is null;
 result:=jsonb_build_object('counts',counts,'missing_notification_intents',missing_receipts,'ungraded_losing_picks',ungraded,'abandoned_leases',expired_leases,'active_period_count',active_days,'campaign_recipient_gaps',missing_audience,
 'review_messages',(select count(*) from __SCHEMA__.notification_outbox where status='review'),
 'oldest_eligible_message',(select min(created_at) from __SCHEMA__.notification_outbox where status='pending' and next_attempt_at<=clock_timestamp() and expires_at>clock_timestamp()),
 'undocumented_overrides',(select count(*) from __SCHEMA__.pick_revisions where origin='administrator' and nullif(btrim(reason),'') is null),
 'cross_season_picks',(select count(*) from __SCHEMA__.picks p join __SCHEMA__.slates s on s.id=p.slate_id where p.pool_id=cfg.id and s.season_year<>cfg.season_year),
 'missing_after_lock',case when (counts->'requirement'->>'deadline')::timestamptz<=clock_timestamp() then counts->'unpicked' else '0'::jsonb end);
 insert into __SCHEMA__.integrity_checks(findings) values(result);
 return result;
end $fn$;

-- 026: championship completion waits only for the active contest's grading.
create or replace function __SCHEMA__.complete_tournament(p_slate uuid) returns boolean language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
begin
 perform pg_advisory_xact_lock(hashtextextended('__SCHEMA__.active-slate',0));
 if not exists(select 1 from __SCHEMA__.slates s join __SCHEMA__.games g on g.slate_id=s.id where s.id=p_slate and s.is_active and s.auto_assign_completed_at is not null and __SCHEMA__.canonical_round(g.round_label)='National Championship') then return false; end if;
 if exists(select 1 from __SCHEMA__.games where slate_id=p_slate and result='pending') or exists(select 1 from __SCHEMA__.picks p join __SCHEMA__.players e on e.id=p.player_id join __SCHEMA__.games g on g.slate_id=p.slate_id where p.slate_id=p_slate and not p.loss_excused and e.status='alive' and e.pool_id=(select id from __SCHEMA__.pools where is_active) and ((p.team=g.home_team and g.result in ('away_win','tie'))or(p.team=g.away_team and g.result in ('home_win','tie')))) then return false; end if;
 update __SCHEMA__.pools set status='completed' where is_active and competition_mode='march-madness';
 update __SCHEMA__.slates set is_active=false where id=p_slate;
 insert into __SCHEMA__.audit_log(event_type,actor,message,details) values('tournament-completed','system','Championship grading complete',jsonb_build_object('slate',p_slate));
 return true;
end $fn$;

-- 027: a game counts as graded once the active contest's entries are graded.
create or replace function __SCHEMA__.mark_results_graded(p_games jsonb) returns integer language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
declare n integer;
begin
 update __SCHEMA__.games g set graded_at=clock_timestamp() from jsonb_to_recordset(p_games) as expected(id uuid,result text) where g.id=expected.id and g.result=expected.result and g.result<>'pending' and not exists(select 1 from __SCHEMA__.picks p join __SCHEMA__.players e on e.id=p.player_id where p.slate_id=g.slate_id and e.status='alive' and e.pool_id=(select id from __SCHEMA__.pools where is_active) and not p.loss_excused and ((p.team=g.home_team and g.result in ('away_win','tie'))or(p.team=g.away_team and g.result in ('home_win','tie'))));
 get diagnostics n=row_count;return n;
end $fn$;

-- 029: day advancement waits only for the active contest's picks.
create or replace function __SCHEMA__.activate_ready_slate(
    p_expected uuid,p_next uuid,p_held uuid[],p_require_open boolean
   ) returns void language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
   declare previous __SCHEMA__.slates%rowtype; next_day __SCHEMA__.slates%rowtype; active_id uuid;
   begin
    perform pg_advisory_xact_lock(hashtextextended('__SCHEMA__.active-slate',0));
    perform id from __SCHEMA__.slates where id in (p_expected,p_next) order by id for update;
    active_id:=(select id from __SCHEMA__.pools where is_active);
    select * into previous from __SCHEMA__.slates where id=p_expected;
    select * into next_day from __SCHEMA__.slates where id=p_next;
    if previous.is_active is distinct from true or previous.auto_assign_completed_at is null then
     raise exception 'Active day changed or assignments incomplete';
    end if;
    if next_day.id is null or next_day.slate_date<=previous.slate_date or next_day.season_year<>previous.season_year then
     raise exception 'Invalid next day';
    end if;
    if p_require_open and (next_day.locks_at is null or next_day.locks_at<=clock_timestamp()) then
     raise exception 'Next pick day is already locked';
    end if;
    if not exists(select 1 from __SCHEMA__.games where slate_id=p_expected)
       or exists(select 1 from __SCHEMA__.games where slate_id=p_expected and result='pending'
         and not (id=any(coalesce(p_held,'{}'::uuid[])))) then
     raise exception 'Results incomplete';
    end if;
    if exists(select 1 from __SCHEMA__.picks pp where pp.slate_id=p_expected and pp.pool_id=active_id and not pp.loss_excused
       and (select count(*) from __SCHEMA__.games g
        where g.slate_id=pp.slate_id and (pp.game_id is null or pp.game_id=g.id)
         and pp.team in (g.home_team,g.away_team) and g.result<>'pending'
         and not (g.id=any(coalesce(p_held,'{}'::uuid[])))) <> 1) then
     raise exception 'A pick still needs a confirmed result';
    end if;
    if exists(select 1 from __SCHEMA__.picks pp join __SCHEMA__.players p on p.id=pp.player_id
      join __SCHEMA__.games g on g.slate_id=pp.slate_id and (pp.game_id is null or pp.game_id=g.id)
      where pp.slate_id=p_expected and pp.pool_id=active_id and p.status='alive' and not pp.loss_excused
       and ((pp.team=g.home_team and g.result in ('away_win','tie')) or (pp.team=g.away_team and g.result in ('home_win','tie')))) then
     raise exception 'Grading incomplete';
    end if;
    perform __SCHEMA__.activate_slate(p_next);
   end $fn$;

-- 023: archive the old contest and open March Madness WITHOUT deleting entries
-- or picks. The snapshot in contest_archives is a recovery copy.
create or replace function __SCHEMA__.start_fresh_tournament(p_expected_pool_id uuid, p_slate_id uuid, p_reason text, p_admin_session text)
    returns uuid language plpgsql set search_path = __SCHEMA__, pg_catalog as $fn$
    declare cfg __SCHEMA__.pools%rowtype; first_day __SCHEMA__.slates%rowtype; saved jsonb; archive_id uuid; new_pool uuid;
      effective_now timestamptz := clock_timestamp(); lock_at timestamptz; entry_count bigint; pick_count bigint;
    begin
      -- Archive and switch are one transaction; racing submissions/jobs finish first or wait.
      lock table __SCHEMA__.pools, __SCHEMA__.players, __SCHEMA__.slates, __SCHEMA__.games,
        __SCHEMA__.picks, __SCHEMA__.notification_outbox in exclusive mode;
      select * into cfg from __SCHEMA__.pools where is_active;
      if not found or cfg.id <> p_expected_pool_id then raise exception 'The active contest changed. Refresh before starting a new contest'; end if;
      if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'A reason is required'; end if;
      select * into first_day from __SCHEMA__.slates where id = p_slate_id;
      if not found then raise exception 'Sync the tournament opening day before starting a new contest'; end if;
      if '__SCHEMA__' = 'sandbox' and to_regclass('sandbox.clock') is not null then
        execute 'select coalesce(simulated_now, clock_timestamp()) from sandbox.clock where id = true' into effective_now;
      end if;
      select least(first_day.locks_at, min(tip_time)) into lock_at from __SCHEMA__.games where slate_id = p_slate_id and not time_tbd;
      if lock_at is null or lock_at <= effective_now then raise exception 'The new opening day must have a future deadline'; end if;
      if not exists (select 1 from __SCHEMA__.games where slate_id = p_slate_id)
        or exists (select 1 from __SCHEMA__.games where slate_id = p_slate_id and (result <> 'pending' or status_state <> 'pre'
          or __SCHEMA__.canonical_round(round_label) is null)) then raise exception 'Opening day needs an authoritative, unstarted tournament schedule'; end if;
      select count(*) into entry_count from __SCHEMA__.players where pool_id = cfg.id;
      select count(*) into pick_count from __SCHEMA__.picks where pool_id = cfg.id;
      select jsonb_build_object('kind', 'contest-rollover', 'pool', to_jsonb(cfg),
        'players', (select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) from __SCHEMA__.players p where p.pool_id = cfg.id),
        'picks', (select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) from __SCHEMA__.picks p where p.pool_id = cfg.id),
        'slates', (select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from __SCHEMA__.slates s),
        'games', (select coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb) from __SCHEMA__.games g),
        'notifications', (select coalesce(jsonb_agg(to_jsonb(n)), '[]'::jsonb) from __SCHEMA__.notification_outbox n)) into saved;
      insert into __SCHEMA__.contest_archives(pool_id, snapshot, reason) values(cfg.id, saved, p_reason) returning id into archive_id;
      if jsonb_array_length(saved->'players') <> entry_count
        or jsonb_array_length(saved->'picks') <> pick_count then raise exception 'Archive verification failed'; end if;
      -- Entries and picks stay with the old contest. Nothing is deleted.
      update __SCHEMA__.notification_outbox set status = 'review' where status = 'pending';
      update __SCHEMA__.slates set is_active = false where is_active;
      -- Retain schedule and results. starts_on scopes registration and competition reads.
      update __SCHEMA__.slates set auto_assign_completed_at = null, auto_assign_claimed_at = null where id = p_slate_id;
      update __SCHEMA__.pools set is_active = false, status = 'archived', ended_on = first_day.slate_date - 1, updated_at = now() where id = cfg.id;
      insert into __SCHEMA__.pools(name, competition_mode, status, season_year, starts_on, pick_frequency,
        pick_deadline_rule, team_reuse_rule, auto_pick_behavior, tiebreaker, is_active)
      values('MADNESS March Madness', 'march-madness', 'open', first_day.season_year, first_day.slate_date,
        'tournament-round', 'first-tip', 'once-per-pool', 'highest-seed', 'seed-total', true) returning id into new_pool;
      perform __SCHEMA__.activate_slate(p_slate_id);
      insert into __SCHEMA__.audit_log(event_type, actor, message, details) values('pool-config-updated', 'admin',
        'Archived previous contest and opened fresh March Madness entries',
        jsonb_build_object('archive_id', archive_id, 'previous_pool_id', cfg.id, 'pool_id', new_pool, 'reason', p_reason,
          'admin_session', p_admin_session, 'archived_entries', entry_count, 'archived_picks', pick_count));
      return archive_id;
    end $fn$;

-- Exactly what delete_archived_contest would remove, without changing anything.
create or replace function __SCHEMA__.delete_archived_contest_preview(p_pool_id uuid) returns jsonb
language plpgsql stable set search_path=__SCHEMA__,pg_catalog as $fn$
declare target __SCHEMA__.pools%rowtype; entry_count bigint; pick_count bigint; blocked text;
begin
 select * into target from __SCHEMA__.pools where id = p_pool_id;
 if not found then return jsonb_build_object('found', false, 'deletable', false, 'blocked_reason', 'Contest not found'); end if;
 select count(*) into entry_count from __SCHEMA__.players where pool_id = target.id;
 select count(*) into pick_count from __SCHEMA__.picks where pool_id = target.id;
 blocked := case when target.is_active then 'The active contest cannot be deleted'
   when target.status <> 'archived' then 'Only archived contests can be deleted'
   when entry_count = 0 and pick_count = 0 then 'Nothing to delete: this contest has no entries or picks' end;
 return jsonb_build_object('found', true, 'pool_id', target.id, 'name', target.name, 'status', target.status,
  'is_active', target.is_active, 'competition_mode', target.competition_mode, 'season_year', target.season_year,
  'starts_on', target.starts_on, 'ended_on', target.ended_on, 'players', entry_count, 'picks', pick_count,
  'deletable', blocked is null, 'blocked_reason', blocked);
end $fn$;

-- Permanently remove one archived contest's entries and picks after writing a
-- verified snapshot. Refuses the active contest and any non-archived pool.
-- A repeat call finds nothing left and changes nothing.
create or replace function __SCHEMA__.delete_archived_contest(p_pool_id uuid, p_confirm_name text, p_reason text, p_admin_session text)
returns jsonb language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
declare target __SCHEMA__.pools%rowtype; entry_count bigint; pick_count bigint; saved jsonb; archive_id uuid;
  deleted_picks bigint; deleted_entries bigint;
begin
 -- Same lock as start_fresh_tournament: no pick, signup or rollover can interleave.
 lock table __SCHEMA__.pools, __SCHEMA__.players, __SCHEMA__.picks in exclusive mode;
 select * into target from __SCHEMA__.pools where id = p_pool_id for update;
 if not found then raise exception 'Contest not found'; end if;
 if target.is_active then raise exception 'The active contest cannot be deleted'; end if;
 if target.status <> 'archived' then raise exception 'Only archived contests can be deleted'; end if;
 if p_confirm_name is null or p_confirm_name <> target.name then raise exception 'Type the exact contest name to confirm deletion'; end if;
 if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'A reason is required'; end if;
 select count(*) into entry_count from __SCHEMA__.players where pool_id = target.id;
 select count(*) into pick_count from __SCHEMA__.picks where pool_id = target.id;
 if entry_count = 0 and pick_count = 0 then
  return jsonb_build_object('deleted', false, 'already_empty', true, 'pool_id', target.id, 'players', 0, 'picks', 0,
   'message', 'Nothing to delete: this contest has no entries or picks. No changes were made.');
 end if;
 saved := jsonb_build_object('kind', 'contest-deletion', 'pool', to_jsonb(target),
  'players', (select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) from __SCHEMA__.players p where p.pool_id = target.id),
  'picks', (select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) from __SCHEMA__.picks p where p.pool_id = target.id));
 if jsonb_array_length(saved->'players') <> entry_count or jsonb_array_length(saved->'picks') <> pick_count then
  raise exception 'Snapshot verification failed; nothing was deleted';
 end if;
 insert into __SCHEMA__.contest_archives(pool_id, snapshot, reason)
  values (target.id, saved, 'Deleted archived contest: ' || btrim(p_reason)) returning id into archive_id;
 delete from __SCHEMA__.picks where pool_id = target.id;
 get diagnostics deleted_picks = row_count;
 delete from __SCHEMA__.players where pool_id = target.id;
 get diagnostics deleted_entries = row_count;
 if deleted_picks <> pick_count or deleted_entries <> entry_count then
  raise exception 'Deletion count mismatch; nothing was deleted';
 end if;
 insert into __SCHEMA__.audit_log(event_type, actor, message, details) values ('contest-deleted', 'admin',
  'Deleted archived contest ' || target.name,
  jsonb_build_object('pool_id', target.id, 'name', target.name, 'archive_id', archive_id, 'players', entry_count,
   'picks', pick_count, 'reason', btrim(p_reason), 'admin_session', p_admin_session));
 return jsonb_build_object('deleted', true, 'archive_id', archive_id, 'pool_id', target.id, 'players', entry_count, 'picks', pick_count,
  'message', 'Deleted ' || entry_count || ' entries and ' || pick_count || ' picks. A recovery snapshot was saved first.');
end $fn$;

-- Read-only history of finished contests, without emails or credentials.
-- Contests removed with delete_archived_contest are not listed.
create or replace function __SCHEMA__.contest_history_list() returns jsonb
language sql stable set search_path=__SCHEMA__,pg_catalog as $fn$
 select coalesce(jsonb_agg(item order by sort_key desc), '[]'::jsonb) from (
  select jsonb_build_object('id', c.id, 'name', c.name, 'competition_mode', c.competition_mode, 'status', c.status,
    'season_year', c.season_year, 'starts_on', c.starts_on, 'ended_on', c.ended_on,
    'entries', case when live.n > 0 then live.n else coalesce(jsonb_array_length(legacy.snapshot->'players'), 0) end,
    'source', case when live.n > 0 then 'live' when legacy.id is not null then 'archive' else 'live' end) as item,
   coalesce(c.ended_on::timestamptz, c.updated_at) as sort_key
  from __SCHEMA__.pools c
  cross join lateral (select count(*) as n from __SCHEMA__.players p where p.pool_id = c.id and p.email not like '%@nflsurvivor.internal') live
  left join lateral (select a.id, a.snapshot from __SCHEMA__.contest_archives a
    where a.pool_id = c.id and coalesce(a.snapshot->>'kind', 'contest-rollover') <> 'contest-deletion'
    order by a.created_at desc limit 1) legacy on true
  where not c.is_active
   and not exists (select 1 from __SCHEMA__.audit_log l where l.event_type = 'contest-deleted' and l.details->>'pool_id' = c.id::text)
   and (live.n > 0 or jsonb_array_length(coalesce(legacy.snapshot->'players', '[]'::jsonb)) > 0)
 ) listed
$fn$;

-- One finished contest's final entries and picks. Live rows are preferred; a
-- contest archived before 030 (rows deleted, JSON only) is read from its snapshot.
create or replace function __SCHEMA__.contest_history(p_pool_id uuid) returns jsonb
language plpgsql stable set search_path=__SCHEMA__,pg_catalog as $fn$
declare c __SCHEMA__.pools%rowtype; snap jsonb; entries jsonb; chosen jsonb; source text := 'live'; slate_ids uuid[];
begin
 select * into c from __SCHEMA__.pools where id = p_pool_id;
 -- The active contest's picks are governed by the reveal rule; never here.
 if not found or c.is_active then return null; end if;
 if exists (select 1 from __SCHEMA__.audit_log l where l.event_type = 'contest-deleted' and l.details->>'pool_id' = c.id::text) then return null; end if;
 if exists (select 1 from __SCHEMA__.players where pool_id = c.id) then
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'full_name', p.full_name, 'status', p.status,
    'elimination_slate', p.elimination_slate, 'elimination_reason', p.elimination_reason) order by p.full_name, p.id), '[]'::jsonb)
   into entries from __SCHEMA__.players p where p.pool_id = c.id and p.email not like '%@nflsurvivor.internal';
  select coalesce(jsonb_agg(jsonb_build_object('player_id', k.player_id, 'slate_id', k.slate_id, 'team', k.team,
    'seed', k.seed, 'loss_excused', k.loss_excused, 'auto_assigned', k.auto_assigned) order by k.slate_id, k.id), '[]'::jsonb)
   into chosen from __SCHEMA__.picks k join __SCHEMA__.players p on p.id = k.player_id
   where k.pool_id = c.id and p.email not like '%@nflsurvivor.internal';
 else
  select a.snapshot into snap from __SCHEMA__.contest_archives a
   where a.pool_id = c.id and coalesce(a.snapshot->>'kind', 'contest-rollover') <> 'contest-deletion'
   order by a.created_at desc limit 1;
  if snap is null then return null; end if;
  source := 'archive';
  select coalesce(jsonb_agg(jsonb_build_object('id', x->>'id', 'full_name', x->>'full_name', 'status', x->>'status',
    'elimination_slate', (x->>'elimination_slate')::integer, 'elimination_reason', x->>'elimination_reason')
    order by x->>'full_name', x->>'id'), '[]'::jsonb)
   into entries from jsonb_array_elements(coalesce(snap->'players', '[]'::jsonb)) x
   where coalesce(x->>'email', '') not like '%@nflsurvivor.internal';
  select coalesce(jsonb_agg(jsonb_build_object('player_id', x->>'player_id', 'slate_id', x->>'slate_id', 'team', x->>'team',
    'seed', (x->>'seed')::integer, 'loss_excused', coalesce((x->>'loss_excused')::boolean, false),
    'auto_assigned', coalesce((x->>'auto_assigned')::boolean, false)) order by x->>'slate_id', x->>'id'), '[]'::jsonb)
   into chosen from jsonb_array_elements(coalesce(snap->'picks', '[]'::jsonb)) x
   where exists (select 1 from jsonb_array_elements(entries) e where e->>'id' = x->>'player_id');
 end if;
 select array_agg(distinct (x->>'slate_id')::uuid) into slate_ids from jsonb_array_elements(chosen) x;
 return jsonb_build_object('source', source,
  'pool', jsonb_build_object('id', c.id, 'name', c.name, 'competition_mode', c.competition_mode, 'status', c.status,
    'season_year', c.season_year, 'starts_on', c.starts_on, 'ended_on', c.ended_on),
  'entries', entries, 'picks', chosen,
  'slates', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'slate_number', s.slate_number, 'slate_date', s.slate_date)
    order by s.slate_date), '[]'::jsonb) from __SCHEMA__.slates s where s.id = any(coalesce(slate_ids, '{}'::uuid[]))),
  'games', (select coalesce(jsonb_agg(jsonb_build_object('slate_id', g.slate_id, 'home_team', g.home_team, 'away_team', g.away_team,
    'result', g.result, 'round_label', g.round_label) order by g.tip_time), '[]'::jsonb)
    from __SCHEMA__.games g where g.slate_id = any(coalesce(slate_ids, '{}'::uuid[]))));
end $fn$;
  $schema$;
  execute replace(ddl, '__SCHEMA__', quote_ident(target));

  -- Drop the global email uniqueness (001/004 column constraint and 022's
  -- normalized index) now that the per-contest index exists.
  select attnum into email_attnum from pg_attribute where attrelid = format('%I.players', target)::regclass and attname = 'email';
  for con in select c.conname from pg_constraint c
    where c.conrelid = format('%I.players', target)::regclass and c.contype = 'u' and c.conkey = array[email_attnum] loop
   execute format('alter table %I.players drop constraint %I', target, con.conname);
  end loop;
  execute format('drop index if exists %I.players_normalized_email_unique', target);

  for ddl in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = target and p.proname = any(array['contest_entry_pool','scope_pick_to_entry','guard_entry_contest',
     'protect_frozen_rules','record_pick_revision','enforce_pick_integrity','restore_player','grade_pick_loss',
     'queue_pick_reminders','activate_slate_checked','apply_assignment','expand_campaign','contest_counts',
     'reconcile_contest','complete_tournament','mark_results_graded','activate_ready_slate','start_fresh_tournament',
     'delete_archived_contest_preview','delete_archived_contest','contest_history_list','contest_history']) loop
   execute 'revoke all on function ' || ddl || ' from public, anon, authenticated';
   execute 'grant execute on function ' || ddl || ' to service_role';
  end loop;
 end loop;
end $migration$;
notify pgrst, 'reload schema';
commit;
