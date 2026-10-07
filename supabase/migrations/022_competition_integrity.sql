-- Additive migration. Apply in staging first. No entries or picks are deleted.
-- Both manual and automatic inserts serialize on the stable player row, so
-- service-role writes and racing workers must obey the same quota.
begin;
do $migration$
declare target text; ddl text;
begin
  foreach target in array array['public', 'sandbox'] loop
    if to_regclass(format('%I.picks', target)) is null then continue; end if;
    ddl := $schema$
      create unique index if not exists players_normalized_email_unique on __SCHEMA__.players (lower(btrim(email)));
      alter table __SCHEMA__.slates add column if not exists assignment_schedule jsonb;
      alter table __SCHEMA__.picks add column if not exists updated_at timestamptz not null default now();
      create or replace function __SCHEMA__.activate_slate(p_slate_id uuid)
      returns void language plpgsql set search_path = __SCHEMA__, pg_catalog as $fn$
      begin
        perform pg_advisory_xact_lock(hashtextextended('__SCHEMA__.active-slate', 0));
        if not exists (select 1 from __SCHEMA__.slates where id = p_slate_id) then
          raise exception 'Slate not found';
        end if;
        update __SCHEMA__.slates set is_active = false where is_active;
        update __SCHEMA__.slates set is_active = true where id = p_slate_id;
      end $fn$;
      revoke all on function __SCHEMA__.activate_slate(uuid) from public, anon, authenticated;
      grant execute on function __SCHEMA__.activate_slate(uuid) to service_role;

      -- Snapshot the last schedule known before the lock. Updates after lock
      -- keep the existing snapshot; late jobs never consult outcomes/rankings.
      create or replace function __SCHEMA__.freeze_assignment_schedule()
      returns trigger language plpgsql set search_path = __SCHEMA__, pg_catalog as $fn$
      declare sid uuid; lock_at timestamptz; frozen jsonb;
      begin
        sid := case when TG_OP = 'DELETE' then old.slate_id else new.slate_id end;
        select locks_at, assignment_schedule into lock_at, frozen
          from __SCHEMA__.slates where id = sid for update;
        if frozen is null or lock_at is null or clock_timestamp() < lock_at then
          update __SCHEMA__.slates set assignment_schedule = (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', id, 'slate_id', slate_id, 'home_team', home_team, 'away_team', away_team,
              'home_seed', home_seed, 'away_seed', away_seed, 'round_label', round_label,
              'tip_time', tip_time, 'time_tbd', time_tbd
            ) order by tip_time desc, espn_event_id), '[]'::jsonb)
            from __SCHEMA__.games where slate_id = sid
          ) where id = sid;
        end if;
        return null;
      end $fn$;
      drop trigger if exists games_assignment_schedule on __SCHEMA__.games;
      create trigger games_assignment_schedule after insert or update or delete on __SCHEMA__.games
        for each row execute function __SCHEMA__.freeze_assignment_schedule();

      create or replace function __SCHEMA__.canonical_round(label text)
      returns text language sql immutable as $fn$
        select case lower(btrim(label))
          when 'first four' then 'First Four' when 'opening round' then 'First Four'
          when '1st round' then '1st Round' when 'first round' then '1st Round' when 'round of 64' then '1st Round'
          when '2nd round' then '2nd Round' when 'second round' then '2nd Round' when 'round of 32' then '2nd Round'
          when 'sweet 16' then 'Sweet 16' when 'sweet sixteen' then 'Sweet 16' when 'regional semifinal' then 'Sweet 16'
          when 'elite 8' then 'Elite 8' when 'elite eight' then 'Elite 8' when 'regional final' then 'Elite 8'
          when 'final four' then 'Final Four' when 'national semifinal' then 'Final Four'
          when 'national championship' then 'National Championship' when 'championship' then 'National Championship'
          when 'championship game' then 'National Championship' else null end
      $fn$;
      create or replace function __SCHEMA__.enforce_pick_integrity()
      returns trigger language plpgsql set search_path = __SCHEMA__, pg_catalog as $fn$
      declare p __SCHEMA__.players%rowtype; s __SCHEMA__.slates%rowtype;
        cfg __SCHEMA__.pools%rowtype; lock_at timestamptz; first_tip timestamptz;
        round_name text; quota integer := 1; period_ids uuid[]; n integer;
        effective_now timestamptz := clock_timestamp();
      begin
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
        if p.status <> 'alive' then raise exception 'You are eliminated'; end if;
        -- Pending grading must not make a previously losing entry eligible.
        if exists (select 1 from __SCHEMA__.picks pp join __SCHEMA__.games g on g.slate_id = pp.slate_id
          where pp.player_id = new.player_id and pp.id <> new.id and
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
      drop trigger if exists picks_integrity on __SCHEMA__.picks;
      create trigger picks_integrity before insert or update on __SCHEMA__.picks
        for each row execute function __SCHEMA__.enforce_pick_integrity();

      create or replace function __SCHEMA__.audit_pick_mutation()
      returns trigger language plpgsql set search_path = __SCHEMA__, pg_catalog as $fn$
      declare display_name text;
      begin
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
      drop trigger if exists picks_atomic_audit on __SCHEMA__.picks;
      create trigger picks_atomic_audit after insert or update on __SCHEMA__.picks
        for each row execute function __SCHEMA__.audit_pick_mutation();
      create table if not exists __SCHEMA__.notification_outbox (
        id uuid primary key default gen_random_uuid(),
        created_at timestamptz not null default now(),
        event_key text not null unique,
        kind text not null,
        payload jsonb not null,
        status text not null default 'pending' check (status in ('pending', 'sent', 'review')),
        attempts integer not null default 0
      );
      alter table __SCHEMA__.notification_outbox enable row level security;
      grant all on __SCHEMA__.notification_outbox to service_role;
      create or replace function __SCHEMA__.queue_elimination_notice()
      returns trigger language plpgsql set search_path = __SCHEMA__, pg_catalog as $fn$
      begin
        if old.status = 'alive' and new.status = 'eliminated' then
          insert into __SCHEMA__.notification_outbox(event_key, kind, payload)
          values ('elimination:' || new.id || ':' || coalesce(new.elimination_slate::text, 'manual'),
            'elimination', jsonb_build_object('player_id', new.id, 'email', new.email,
              'name', new.full_name, 'slate_number', new.elimination_slate, 'reason', new.elimination_reason))
          on conflict (event_key) do nothing;
        end if;
        return null;
      end $fn$;
      drop trigger if exists players_elimination_notice on __SCHEMA__.players;
      create trigger players_elimination_notice after update on __SCHEMA__.players
        for each row execute function __SCHEMA__.queue_elimination_notice();
      -- Existing schedules become the initial frozen baseline at migration.
      -- For already-locked days this is recovery evidence, not a claim that
      -- a historical lock-time snapshot existed before this migration.
      update __SCHEMA__.slates s set assignment_schedule = (
        select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'slate_id', g.slate_id,
          'home_team', g.home_team, 'away_team', g.away_team, 'home_seed', g.home_seed,
          'away_seed', g.away_seed, 'round_label', g.round_label, 'tip_time', g.tip_time,
          'time_tbd', g.time_tbd) order by tip_time desc, espn_event_id), '[]'::jsonb)
        from __SCHEMA__.games g where g.slate_id = s.id
      ) where assignment_schedule is null;
    $schema$;
    execute replace(ddl, '__SCHEMA__', quote_ident(target));
  end loop;
end $migration$;
notify pgrst, 'reload schema';
commit;
