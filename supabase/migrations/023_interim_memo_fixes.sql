-- Requires 022. Additive schema changes; no live participants changed by applying this migration.
begin;
do $migration$
declare target text; ddl text;
begin
 foreach target in array array['public', 'sandbox'] loop
  if to_regclass(format('%I.picks', target)) is null then continue; end if;
  ddl := $schema$
    alter table __SCHEMA__.picks add column if not exists loss_excused boolean not null default false;
    create table if not exists __SCHEMA__.revoked_sessions (
      token_hash text primary key, expires_at timestamptz not null
    );
    alter table __SCHEMA__.revoked_sessions enable row level security;
    revoke all on __SCHEMA__.revoked_sessions from public, anon, authenticated;
    grant all on __SCHEMA__.revoked_sessions to service_role;
    create table if not exists __SCHEMA__.contest_archives (
      id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(),
      pool_id uuid not null, snapshot jsonb not null, reason text not null
    );
    alter table __SCHEMA__.contest_archives enable row level security;
    revoke all on __SCHEMA__.contest_archives from public, anon, authenticated;
    grant all on __SCHEMA__.contest_archives to service_role;
      create or replace function __SCHEMA__.enforce_pick_integrity()
      returns trigger language plpgsql set search_path = __SCHEMA__, pg_catalog as $fn$
      declare p __SCHEMA__.players%rowtype; s __SCHEMA__.slates%rowtype;
        cfg __SCHEMA__.pools%rowtype; lock_at timestamptz; first_tip timestamptz;
        round_name text; quota integer := 1; period_ids uuid[]; n integer;
        effective_now timestamptz := clock_timestamp();
      begin
        if TG_OP = 'UPDATE' and new.loss_excused is distinct from old.loss_excused
          and (to_jsonb(new) - 'loss_excused') = (to_jsonb(old) - 'loss_excused') then return new; end if;
        if TG_OP = 'UPDATE' and (new.player_id <> old.player_id or new.slate_id <> old.slate_id) then
          raise exception 'Pick ownership and period are immutable';
        end if;
        select * into p from __SCHEMA__.players where id = new.player_id for update;
        if not found then raise exception 'Player not found'; end if;
        select * into cfg from __SCHEMA__.pools where is_active for share;
        if not found or cfg.pick_deadline_rule <> 'first-tip' or cfg.team_reuse_rule <> 'once-per-pool'
          or cfg.pick_frequency = 'weekends-only' then raise exception 'Competition rules unavailable or unsupported'; end if;
        select * into s from __SCHEMA__.slates where id = new.slate_id for share;
        if not found then raise exception 'Slate not found'; end if;
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
        if '__SCHEMA__' = 'sandbox' and to_regclass('sandbox.clock') is not null then
          execute 'select coalesce(simulated_now, clock_timestamp()) from sandbox.clock where id = true' into effective_now;
        end if;
        if not new.auto_assigned and not new.submitted_by_admin then
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
        new.updated_at := clock_timestamp();
        return new;
      end $fn$;

      create or replace function __SCHEMA__.audit_pick_mutation()
      returns trigger language plpgsql set search_path = __SCHEMA__, pg_catalog as $fn$
      declare display_name text;
      begin
        if TG_OP = 'UPDATE' and new.team = old.team and new.loss_excused is distinct from old.loss_excused then return null; end if;
        select full_name into display_name from __SCHEMA__.players where id = new.player_id;
        insert into __SCHEMA__.audit_log(event_type, actor, player_id, player_name, message, details)
        values (case when TG_OP = 'UPDATE' then 'pick-changed' when new.auto_assigned then 'pick-auto-assigned' else 'pick-submitted' end,
          case when new.submitted_by_admin then 'admin' when new.auto_assigned then 'system' else 'player' end,
          new.player_id, display_name, display_name || ' picked ' || new.team,
          jsonb_build_object('pick_id', new.id, 'slate_id', new.slate_id, 'team', new.team,
            'previous_team', case when TG_OP = 'UPDATE' then old.team else null end,
            'accepted_at', new.updated_at, 'policy_version', '2026-10-07'));
        return null;
      end $fn$;

    create or replace function __SCHEMA__.restore_player(p_player_id uuid, p_reason text, p_admin_session text default null)
    returns void language plpgsql set search_path = __SCHEMA__, pg_catalog as $fn$
    declare previous __SCHEMA__.players%rowtype; excused uuid[];
    begin
      if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'A restoration reason is required'; end if;
      select * into previous from __SCHEMA__.players where id = p_player_id for update;
      if not found then raise exception 'Player not found'; end if;
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
      -- Suppressed elimination events must not later describe a restored entry as out.
      update __SCHEMA__.notification_outbox set status = 'review'
        where kind = 'elimination' and payload->>'player_id' = p_player_id::text and status = 'pending';
    end $fn$;
    revoke all on function __SCHEMA__.restore_player(uuid, text, text) from public, anon, authenticated;
    grant execute on function __SCHEMA__.restore_player(uuid, text, text) to service_role;

    create or replace function __SCHEMA__.grade_pick_loss(p_pick_id uuid, p_slate_number integer, p_reason text)
    returns boolean language plpgsql set search_path = __SCHEMA__, pg_catalog as $fn$
    declare owner_id uuid; entry __SCHEMA__.players%rowtype; chosen __SCHEMA__.picks%rowtype;
    begin
      select player_id into owner_id from __SCHEMA__.picks where id = p_pick_id;
      if not found then return false; end if;
      select * into entry from __SCHEMA__.players where id = owner_id for update;
      if not found or entry.status <> 'alive' then return false; end if;
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
    revoke all on function __SCHEMA__.grade_pick_loss(uuid, integer, text) from public, anon, authenticated;
    grant execute on function __SCHEMA__.grade_pick_loss(uuid, integer, text) to service_role;

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
        and (select count(*) from __SCHEMA__.picks where player_id = p.id and slate_id = any(p_period_ids)) < p_quota
      on conflict(event_key) do nothing;
      get diagnostics n = row_count; return n;
    end $fn$;
    revoke all on function __SCHEMA__.queue_pick_reminders(uuid, uuid[], uuid[], integer, timestamptz, text) from public, anon, authenticated;
    grant execute on function __SCHEMA__.queue_pick_reminders(uuid, uuid[], uuid[], integer, timestamptz, text) to service_role;

    create or replace function __SCHEMA__.start_fresh_tournament(p_expected_pool_id uuid, p_slate_id uuid, p_reason text, p_admin_session text)
    returns uuid language plpgsql set search_path = __SCHEMA__, pg_catalog as $fn$
    declare cfg __SCHEMA__.pools%rowtype; first_day __SCHEMA__.slates%rowtype; saved jsonb; archive_id uuid; new_pool uuid;
      effective_now timestamptz := clock_timestamp(); lock_at timestamptz;
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
      select jsonb_build_object('pool', to_jsonb(cfg),
        'players', (select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) from __SCHEMA__.players p),
        'picks', (select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) from __SCHEMA__.picks p),
        'slates', (select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from __SCHEMA__.slates s),
        'games', (select coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb) from __SCHEMA__.games g),
        'notifications', (select coalesce(jsonb_agg(to_jsonb(n)), '[]'::jsonb) from __SCHEMA__.notification_outbox n)) into saved;
      insert into __SCHEMA__.contest_archives(pool_id, snapshot, reason) values(cfg.id, saved, p_reason) returning id into archive_id;
      -- Only discard rows after verifying the archive's participant/pick counts.
      if jsonb_array_length(saved->'players') <> (select count(*) from __SCHEMA__.players)
        or jsonb_array_length(saved->'picks') <> (select count(*) from __SCHEMA__.picks) then raise exception 'Archive verification failed'; end if;
      delete from __SCHEMA__.picks;
      delete from __SCHEMA__.players;
      update __SCHEMA__.notification_outbox set status = 'review' where status = 'pending';
      update __SCHEMA__.slates set is_active = false where is_active;
      -- Retain schedule and results. starts_on scopes registration and competition reads.
      update __SCHEMA__.slates set auto_assign_completed_at = null, auto_assign_claimed_at = null where id = p_slate_id;
      update __SCHEMA__.pools set is_active = false, status = 'archived', updated_at = now() where id = cfg.id;
      insert into __SCHEMA__.pools(name, competition_mode, status, season_year, starts_on, pick_frequency,
        pick_deadline_rule, team_reuse_rule, auto_pick_behavior, tiebreaker, is_active)
      values('MADNESS March Madness', 'march-madness', 'open', first_day.season_year, first_day.slate_date,
        'tournament-round', 'first-tip', 'once-per-pool', 'highest-seed', 'seed-total', true) returning id into new_pool;
      perform __SCHEMA__.activate_slate(p_slate_id);
      insert into __SCHEMA__.audit_log(event_type, actor, message, details) values('pool-config-updated', 'admin',
        'Archived previous contest and opened fresh March Madness entries',
        jsonb_build_object('archive_id', archive_id, 'previous_pool_id', cfg.id, 'pool_id', new_pool, 'reason', p_reason, 'admin_session', p_admin_session));
      return archive_id;
    end $fn$;
    revoke all on function __SCHEMA__.start_fresh_tournament(uuid, uuid, text, text) from public, anon, authenticated;
    grant execute on function __SCHEMA__.start_fresh_tournament(uuid, uuid, text, text) to service_role;
  $schema$;
  execute replace(ddl, '__SCHEMA__', quote_ident(target));
 end loop;
end $migration$;
notify pgrst, 'reload schema';
commit;
