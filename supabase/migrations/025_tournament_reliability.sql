-- Depends on 001-024. Additive; no production activation or sending.
begin;
do $migration$
declare target text; ddl text;
begin
foreach target in array array['public','sandbox'] loop
ddl := $schema$
alter table __SCHEMA__.teams add column if not exists espn_id text;
alter table __SCHEMA__.games add column if not exists home_team_id text;
alter table __SCHEMA__.games add column if not exists away_team_id text;
alter table __SCHEMA__.picks add column if not exists team_id text;
alter table __SCHEMA__.picks add column if not exists game_id uuid;
create unique index if not exists pick_stable_team on __SCHEMA__.picks(player_id,team_id) where team_id is not null;
alter table __SCHEMA__.picks add column if not exists version integer not null default 1;
create table if not exists __SCHEMA__.rule_versions(id uuid primary key default gen_random_uuid(), configuration jsonb not null, frozen_at timestamptz not null default clock_timestamp(), actor text not null, reason text not null);
create table if not exists __SCHEMA__.delivery_settings(
 id boolean primary key default true check(id), mode text not null default 'record-only' check(mode in ('record-only','test-recipients','live')),
 allowlist text[] not null default '{}', activation_at timestamptz, changed_at timestamptz not null default clock_timestamp(), changed_by text not null default 'migration', reason text not null default 'Delivery intentionally disabled',
 rate_next_at timestamptz, paused_until timestamptz, pause_reason text
);
insert into __SCHEMA__.delivery_settings(id) values(true) on conflict do nothing;
create table if not exists __SCHEMA__.email_campaigns(
 id uuid primary key default gen_random_uuid(), request_id uuid not null unique, subject text not null, message text not null,
 contest_id uuid references __SCHEMA__.pools(id),
 audience text not null check(audience in ('all','alive','unpicked','selected')), selected_ids uuid[] not null default '{}',
 status text not null default 'expanding' check(status in ('expanding','expanded','canceled')),
 created_at timestamptz not null default clock_timestamp(), audience_cutoff timestamptz not null default clock_timestamp(),
 cursor_id uuid, slate_id uuid, period_ids uuid[] not null default '{}', quota integer not null default 1,
 actor text not null, expires_at timestamptz not null default clock_timestamp()+interval '24 hours', provenance text not null
);
alter table __SCHEMA__.notification_outbox drop constraint if exists notification_outbox_status_check;
alter table __SCHEMA__.notification_outbox add constraint notification_outbox_status_check check(status in ('held','pending','processing','sent','review','suppressed','expired','canceled'));
alter table __SCHEMA__.notification_outbox alter column status set default 'held';
alter table __SCHEMA__.notification_outbox add column if not exists recipient text;
alter table __SCHEMA__.notification_outbox add column if not exists contest_id uuid;
alter table __SCHEMA__.notification_outbox add column if not exists player_id uuid;
alter table __SCHEMA__.notification_outbox add column if not exists campaign_id uuid references __SCHEMA__.email_campaigns(id);
alter table __SCHEMA__.notification_outbox add column if not exists expires_at timestamptz;
alter table __SCHEMA__.notification_outbox add column if not exists priority integer not null default 50;
alter table __SCHEMA__.notification_outbox add column if not exists provenance text not null default '__SCHEMA__';
alter table __SCHEMA__.notification_outbox add column if not exists template_version text not null default '2026-10-22';
alter table __SCHEMA__.notification_outbox add column if not exists delivery_outcome text;
alter table __SCHEMA__.notification_outbox add column if not exists frozen_request jsonb;
alter table __SCHEMA__.notification_outbox add column if not exists first_attempt_at timestamptz;
alter table __SCHEMA__.notification_outbox add column if not exists accepted_at timestamptz;
create unique index if not exists notification_provider_unique on __SCHEMA__.notification_outbox(provider_id) where provider_id is not null;
create index if not exists notification_recipient_idx on __SCHEMA__.notification_outbox(recipient,created_at desc);
create index if not exists notification_campaign_idx on __SCHEMA__.notification_outbox(campaign_id,status);
create index if not exists notification_delivery_due on __SCHEMA__.notification_outbox(priority,next_attempt_at,created_at) where status in ('pending','processing');
create table if not exists __SCHEMA__.campaign_recipients(campaign_id uuid references __SCHEMA__.email_campaigns(id),player_id uuid not null,notification_id uuid references __SCHEMA__.notification_outbox(id),primary key(campaign_id,player_id));
create table if not exists __SCHEMA__.notification_attempts(id uuid primary key default gen_random_uuid(),notification_id uuid not null references __SCHEMA__.notification_outbox(id),token uuid not null,started_at timestamptz not null default clock_timestamp(),finished_at timestamptz,outcome text,provider_id text,error_code text,correlation_id uuid not null default gen_random_uuid());
create table if not exists __SCHEMA__.provider_events(id text primary key,provider_id text not null,kind text not null,occurred_at timestamptz not null,received_at timestamptz not null default clock_timestamp());
create index if not exists provider_events_message on __SCHEMA__.provider_events(provider_id);
create table if not exists __SCHEMA__.pick_revisions(id uuid primary key default gen_random_uuid(),pick_id uuid not null,player_id uuid not null,slate_id uuid not null,version integer not null,previous_team text,team text not null,accepted_at timestamptz not null,actor text not null,origin text not null,reason text,rule_version uuid references __SCHEMA__.rule_versions(id),unique(pick_id,version));
create table if not exists __SCHEMA__.pick_requests(player_id uuid not null,request_id uuid not null,request jsonb not null,receipt jsonb not null,created_at timestamptz not null default clock_timestamp(),primary key(player_id,request_id));
create table if not exists __SCHEMA__.integrity_checks(id uuid primary key default gen_random_uuid(),observed_at timestamptz not null default clock_timestamp(),findings jsonb not null);
create table if not exists __SCHEMA__.incidents(key text primary key,impact text not null,first_at timestamptz not null default clock_timestamp(),latest_at timestamptz not null default clock_timestamp(),occurrences integer not null default 1,correlation_id uuid,status text not null default 'open',details text);
alter table __SCHEMA__.operation_runs add column if not exists progress jsonb not null default '{}';
alter table __SCHEMA__.operation_runs add column if not exists correlation_id uuid not null default gen_random_uuid();
-- All existing unsent records stay held. Activation only affects newly-created records.
update __SCHEMA__.notification_outbox set status='held',lease_token=null,lease_until=null where status='pending';
create or replace function __SCHEMA__.stage_campaign() returns trigger language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
begin
 new.contest_id:=coalesce(new.contest_id,(select id from __SCHEMA__.pools where is_active));return new;
end $fn$;
drop trigger if exists campaigns_contest on __SCHEMA__.email_campaigns;
create trigger campaigns_contest before insert on __SCHEMA__.email_campaigns for each row execute function __SCHEMA__.stage_campaign();
create or replace function __SCHEMA__.stage_notification() returns trigger language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
declare cfg __SCHEMA__.delivery_settings%rowtype;
begin
 select * into cfg from __SCHEMA__.delivery_settings where id=true;
 new.contest_id:=coalesce(new.contest_id,(select contest_id from __SCHEMA__.email_campaigns where id=new.campaign_id),(select id from __SCHEMA__.pools where is_active));
 new.recipient:=lower(btrim(coalesce(new.recipient,new.payload->>'email')));
 new.player_id:=coalesce(new.player_id,(new.payload->>'player_id')::uuid);
 if new.campaign_id is not null and exists(select 1 from __SCHEMA__.email_campaigns c where c.id=new.campaign_id and (c.created_at<cfg.activation_at or c.provenance<>'production')) then new.provenance:='test'; end if;
 new.expires_at:=coalesce(new.expires_at,case when new.kind='reminder' then (new.payload->>'deadline')::timestamptz else clock_timestamp()+interval '24 hours' end);
 if cfg.mode='record-only' or '__SCHEMA__'='sandbox' or new.provenance<>'public' or cfg.activation_at is null or new.created_at<cfg.activation_at then new.status:='held';
 elsif cfg.mode='test-recipients' and not(coalesce(new.recipient,'')=any(cfg.allowlist)) then new.status:='held';
 else new.status:='pending'; end if;
 return new;
end $fn$;
drop trigger if exists notifications_stage on __SCHEMA__.notification_outbox;
create trigger notifications_stage before insert on __SCHEMA__.notification_outbox for each row execute function __SCHEMA__.stage_notification();
create or replace function __SCHEMA__.record_pick_revision() returns trigger language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
declare rule_id uuid; notice_kind text;
begin
 select r.id into rule_id from __SCHEMA__.rule_versions r join __SCHEMA__.pools p on r.configuration->>'id'=p.id::text where p.is_active order by r.frozen_at desc,r.id limit 1;
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
drop trigger if exists picks_revision on __SCHEMA__.picks;
create trigger picks_revision after insert or update of team on __SCHEMA__.picks for each row execute function __SCHEMA__.record_pick_revision();
create or replace function __SCHEMA__.save_pick(p_player_id uuid,p_slate_id uuid,p_team text,p_request_id uuid,p_pick_id uuid default null,p_expected timestamptz default null,p_admin_actor text default null,p_reason text default null)
returns jsonb language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
declare prior __SCHEMA__.pick_requests%rowtype; saved __SCHEMA__.picks%rowtype; request_body jsonb; receipt jsonb; deadline timestamptz;
begin
 -- Every application mutation takes the player lock before pick and slate locks.
 perform 1 from __SCHEMA__.players where id=p_player_id for update;
 if not found then raise exception 'Player not found'; end if;
 request_body:=jsonb_build_object('slate',p_slate_id,'team',p_team,'pick',p_pick_id,'expected',p_expected,'actor',p_admin_actor,'reason',p_reason);
 select * into prior from __SCHEMA__.pick_requests where player_id=p_player_id and request_id=p_request_id;
 if found then
  if prior.request<>request_body then raise exception 'Request ID reused with different selection'; end if;
  return prior.receipt;
 end if;
 if p_admin_actor is not null and length(btrim(coalesce(p_reason,'')))<3 then raise exception 'Administrator correction requires a reason'; end if;
 perform set_config('madness.actor',coalesce(p_admin_actor,p_player_id::text),true);
 perform set_config('madness.reason',coalesce(p_reason,''),true);
 if p_pick_id is not null then
  select * into saved from __SCHEMA__.picks where id=p_pick_id and player_id=p_player_id and slate_id=p_slate_id for update;
  if not found or saved.updated_at is distinct from p_expected then raise exception 'Stale pick version'; end if;
  if saved.team<>p_team then
   update __SCHEMA__.picks set team=p_team,seed=(select case when home_team=p_team then home_seed else away_seed end from __SCHEMA__.games where slate_id=p_slate_id and p_team in(home_team,away_team) limit 1),auto_assigned=false,submitted_by_admin=p_admin_actor is not null where id=p_pick_id returning * into saved;
  end if;
 else
  insert into __SCHEMA__.picks(player_id,slate_id,team,seed,auto_assigned,submitted_by_admin)
  values(p_player_id,p_slate_id,p_team,(select case when home_team=p_team then home_seed else away_seed end from __SCHEMA__.games where slate_id=p_slate_id and p_team in(home_team,away_team) limit 1),false,p_admin_actor is not null) returning * into saved;
 end if;
 select least(s.locks_at,(select min(tip_time) from __SCHEMA__.games where slate_id=s.id and not time_tbd)) into deadline from __SCHEMA__.slates s where s.id=p_slate_id;
 receipt:=jsonb_build_object('pick',to_jsonb(saved),'acceptedAt',saved.updated_at,'version',saved.version,'periodId',saved.slate_id,'deadline',deadline,'requestId',p_request_id);
 insert into __SCHEMA__.pick_requests(player_id,request_id,request,receipt) values(p_player_id,p_request_id,request_body,receipt);
 return receipt;
end $fn$;
create or replace function __SCHEMA__.set_delivery_mode(p_mode text,p_allowlist text[],p_actor text,p_reason text) returns void language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
begin
 if p_mode not in ('record-only','test-recipients','live') or length(btrim(p_reason))<3 then raise exception 'Valid mode and explanation required'; end if;
 if p_mode='test-recipients' and cardinality(p_allowlist)=0 then raise exception 'Test allowlist required'; end if;
 update __SCHEMA__.delivery_settings set mode=p_mode,allowlist=p_allowlist,activation_at=clock_timestamp(),changed_at=clock_timestamp(),changed_by=p_actor,reason=p_reason where id=true;
 -- Never release historical mail. Already processing attempts may have reached the provider.
 update __SCHEMA__.notification_outbox set status='held',last_error='Held after delivery mode change' where status='pending';
 insert into __SCHEMA__.audit_log(event_type,actor,message,details) values('delivery-mode-changed','admin','Delivery mode changed',jsonb_build_object('mode',p_mode,'actor',p_actor,'reason',p_reason));
end $fn$;
create or replace function __SCHEMA__.claim_notifications(p_limit integer default 10) returns setof __SCHEMA__.notification_outbox language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
declare cfg __SCHEMA__.delivery_settings%rowtype;
begin
 select * into cfg from __SCHEMA__.delivery_settings where id=true;
 if cfg.mode='record-only' or '__SCHEMA__'='sandbox' or cfg.paused_until>clock_timestamp() then return; end if;
 update __SCHEMA__.notification_outbox set status='expired',last_error='Message expired',lease_token=null,lease_until=null where status in ('pending','processing') and expires_at<=clock_timestamp() and (lease_until is null or lease_until<=clock_timestamp());
 update __SCHEMA__.notification_outbox set status='review',last_error='Provider idempotency window requires reconciliation',lease_token=null,lease_until=null where status in ('pending','processing') and first_attempt_at<clock_timestamp()-interval '23 hours' and (lease_until is null or lease_until<=clock_timestamp());
 return query with due as(
 select id from __SCHEMA__.notification_outbox where status in ('pending','processing') and next_attempt_at<=clock_timestamp() and (lease_until is null or lease_until<=clock_timestamp()) and created_at>=cfg.activation_at and provenance='public'
 and (cfg.mode='live' or recipient=any(cfg.allowlist)) order by priority,created_at,id for update skip locked limit least(50,greatest(1,p_limit))
 ) update __SCHEMA__.notification_outbox n set status='processing',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes' from due where n.id=due.id returning n.*;
end $fn$;
create or replace function __SCHEMA__.prepare_notification(p_id uuid,p_token uuid,p_request jsonb) returns jsonb language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
declare result jsonb; mode_now text;
begin
 select mode into mode_now from __SCHEMA__.delivery_settings where id=true for share;
 if mode_now='record-only' then return null; end if;
 update __SCHEMA__.notification_outbox set frozen_request=coalesce(frozen_request,p_request),first_attempt_at=coalesce(first_attempt_at,clock_timestamp()),attempts=attempts+1
 where id=p_id and lease_token=p_token and lease_until>clock_timestamp() and status='processing' and expires_at>clock_timestamp()
 and (first_attempt_at is null or first_attempt_at>clock_timestamp()-interval '23 hours') returning frozen_request into result;
 if result is not null then insert into __SCHEMA__.notification_attempts(notification_id,token) values(p_id,p_token); end if;
 return result;
end $fn$;
create or replace function __SCHEMA__.reserve_email_slot() returns boolean language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
begin
 update __SCHEMA__.delivery_settings set rate_next_at=clock_timestamp()+interval '550 milliseconds' where id=true and mode<>'record-only' and (rate_next_at is null or rate_next_at<=clock_timestamp()) and (paused_until is null or paused_until<=clock_timestamp());
 return found;
end $fn$;
create or replace function __SCHEMA__.settle_notification(p_id uuid,p_token uuid,p_status text,p_code text default null,p_provider_id text default null,p_delay integer default 60) returns boolean language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
begin
 if p_status not in ('sent','pending','review','suppressed','expired','canceled') then raise exception 'Invalid delivery state'; end if;
 update __SCHEMA__.notification_outbox set status=case when p_status='pending' and attempts>=8 then 'review' else p_status end,provider_id=coalesce(p_provider_id,provider_id),accepted_at=case when p_status='sent' then clock_timestamp() else accepted_at end,last_error=p_code,lease_token=null,lease_until=null,next_attempt_at=clock_timestamp()+make_interval(secs=>least(86400,greatest(1,p_delay))) where id=p_id and lease_token=p_token and lease_until>clock_timestamp() and status='processing';
 if not found then return false; end if;
 update __SCHEMA__.notification_attempts set finished_at=clock_timestamp(),outcome=p_status,error_code=p_code,provider_id=p_provider_id where notification_id=p_id and token=p_token and finished_at is null;
 -- A webhook may arrive before the provider HTTP response.
 update __SCHEMA__.notification_outbox n set delivery_outcome=(select e.kind from __SCHEMA__.provider_events e where e.provider_id=n.provider_id order by case e.kind when 'email.complained' then 5 when 'email.bounced' then 4 when 'email.delivered' then 3 when 'email.delivery_delayed' then 2 else 1 end desc,e.occurred_at desc limit 1) where n.id=p_id;
 return true;
end $fn$;
create or replace function __SCHEMA__.record_provider_event(p_id text,p_provider_id text,p_kind text,p_at timestamptz,p_recipients text[]) returns void language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
begin
 insert into __SCHEMA__.provider_events(id,provider_id,kind,occurred_at) values(p_id,p_provider_id,p_kind,p_at) on conflict do nothing;
 if not found then return; end if;
 if p_kind in ('email.bounced','email.complained') then insert into __SCHEMA__.email_suppressions(email,reason) select lower(btrim(x)),p_kind from unnest(p_recipients) x on conflict(email) do update set reason=excluded.reason; end if;
 update __SCHEMA__.notification_outbox n set delivery_outcome=(select e.kind from __SCHEMA__.provider_events e where e.provider_id=p_provider_id order by case e.kind when 'email.complained' then 5 when 'email.bounced' then 4 when 'email.delivered' then 3 when 'email.delivery_delayed' then 2 else 1 end desc,e.occurred_at desc limit 1) where n.provider_id=p_provider_id;
end $fn$;
create or replace function __SCHEMA__.expand_campaign(p_id uuid,p_limit integer default 200) returns integer language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
declare c __SCHEMA__.email_campaigns%rowtype; p record; nid uuid; total integer:=0;
begin
 select * into c from __SCHEMA__.email_campaigns where id=p_id for update skip locked;
 if not found or c.status<>'expanding' then return 0; end if;
 if c.contest_id is distinct from (select id from __SCHEMA__.pools where is_active) then update __SCHEMA__.email_campaigns set status='canceled' where id=c.id;return 0;end if;
 for p in select * from __SCHEMA__.players where (c.cursor_id is null or id>c.cursor_id) and created_at<=c.audience_cutoff order by id limit least(500,greatest(1,p_limit)) loop
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
create or replace function __SCHEMA__.cancel_campaign(p_id uuid,p_actor text,p_reason text) returns void language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
begin
 if length(btrim(p_reason))<3 then raise exception 'Reason required'; end if;
 perform 1 from __SCHEMA__.email_campaigns where id=p_id for update;
 update __SCHEMA__.email_campaigns set status='canceled' where id=p_id;
 update __SCHEMA__.notification_outbox set status='canceled',last_error='Campaign canceled' where campaign_id=p_id and status in ('held','pending');
 insert into __SCHEMA__.audit_log(event_type,actor,message,details) values('campaign-canceled','admin','Remaining unsent campaign messages canceled',jsonb_build_object('campaign',p_id,'actor',p_actor,'reason',p_reason));
end $fn$;
-- Freeze the first effective rules automatically on the first accepted pick.
insert into __SCHEMA__.rule_versions(configuration,actor,reason) select to_jsonb(p),'migration','Baseline rules for existing contest; historical rules not reconstructed' from __SCHEMA__.pools p where p.is_active and exists(select 1 from __SCHEMA__.picks) and not exists(select 1 from __SCHEMA__.rule_versions r where r.configuration->>'id'=p.id::text);
create or replace function __SCHEMA__.freeze_rules() returns trigger language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
begin
 if exists(select 1 from __SCHEMA__.rule_versions r join __SCHEMA__.pools p on r.configuration->>'id'=p.id::text where p.is_active) then return new; end if;
 perform pg_advisory_xact_lock(hashtextextended('__SCHEMA__.rules',0));
 perform 1 from __SCHEMA__.pools where is_active for share;
 if not exists(select 1 from __SCHEMA__.rule_versions r join __SCHEMA__.pools p on r.configuration->>'id'=p.id::text where p.is_active) then
 insert into __SCHEMA__.rule_versions(configuration,actor,reason) select to_jsonb(p),'database','Initial contest rule freeze' from __SCHEMA__.pools p where is_active;
 end if;
 return new;
end $fn$;
drop trigger if exists picks_freeze_rules on __SCHEMA__.picks;
create trigger picks_freeze_rules before insert on __SCHEMA__.picks for each statement execute function __SCHEMA__.freeze_rules();
create or replace function __SCHEMA__.protect_frozen_rules() returns trigger language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
begin
 if exists(select 1 from __SCHEMA__.picks) and exists(select 1 from __SCHEMA__.rule_versions where configuration->>'id'=old.id::text) and (to_jsonb(new)-array['updated_at','status','name','is_active']) is distinct from (to_jsonb(old)-array['updated_at','status','name','is_active']) then raise exception 'Contest rules are frozen; reviewed rule amendment required'; end if;
 return new;
end $fn$;
drop trigger if exists pools_frozen_rules on __SCHEMA__.pools;
create trigger pools_frozen_rules before update on __SCHEMA__.pools for each row execute function __SCHEMA__.protect_frozen_rules();

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
        select * into cfg from __SCHEMA__.pools where is_active for share;
        if not found or cfg.pick_deadline_rule <> 'first-tip' or cfg.team_reuse_rule <> 'once-per-pool'
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
create or replace function __SCHEMA__.contest_backup()
   returns jsonb language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
   declare backup_tables text[]:=array['teams','pools','slates','players','games','picks','audit_log','notification_outbox','contest_archives','revoked_sessions','operation_runs','email_suppressions','delivery_settings','email_campaigns','campaign_recipients','notification_attempts','provider_events','pick_revisions','pick_requests','rule_versions','integrity_checks','incidents'];
    t text; rows jsonb; result jsonb:='{}'::jsonb; columns jsonb:='{}'::jsonb; definition jsonb;
   begin
    foreach t in array array['rate_limits','clock','player_accounts','notification_preferences','push_devices'] loop
      if to_regclass(format('%I.%I','__SCHEMA__',t)) is not null then backup_tables:=array_append(backup_tables,t); end if;
    end loop;
    if exists(select 1 from information_schema.tables where table_schema='__SCHEMA__' and table_type='BASE TABLE' and table_name<>all(backup_tables)) then
      raise exception 'Unrecognized application table; extend backup coverage before continuing';
    end if;
    -- A share lock gives all table reads the same stable application state.
    foreach t in array backup_tables loop execute format('lock table %I.%I in share mode','__SCHEMA__',t); end loop;
    foreach t in array backup_tables loop
     execute format('select coalesce(jsonb_agg(to_jsonb(r)),''[]''::jsonb) from %I.%I r','__SCHEMA__',t) into rows;
     result:=result||jsonb_build_object(t,rows);
     select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod)) order by a.attnum)
       into definition from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='__SCHEMA__' and c.relname=t and a.attnum>0 and not a.attisdropped;
     columns:=columns||jsonb_build_object(t,definition);
    end loop;
    return jsonb_build_object('version',2,'schema','__SCHEMA__','created_at',clock_timestamp(),'tables',result,'columns',columns);
   end $fn$;

create or replace function __SCHEMA__.apply_assignment(p_slate_id uuid,p_token uuid,p_player_id uuid,p_teams jsonb,p_reason text default null,p_period_ids uuid[] default null,p_expected_count integer default 0)
   returns void language plpgsql set search_path=__SCHEMA__,pg_catalog as $fn$
   declare s __SCHEMA__.slates%rowtype; t jsonb;
   begin
    perform 1 from __SCHEMA__.players where id=p_player_id for update;
    select * into s from __SCHEMA__.slates where id=p_slate_id for share;
    if not found or not s.is_active or s.assignment_token is distinct from p_token or s.auto_assign_claimed_at<clock_timestamp()-interval '4 minutes' then raise exception 'Assignment lease lost'; end if;
    perform set_config('madness.assignment_token',p_token::text,true);
    -- Recheck the expected quota state under the same player lock as manual writes.
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
$schema$;
execute replace(ddl,'__SCHEMA__',target);
-- New tables/functions are service-only; application verifies sessions before RPC.
for ddl in select tablename from pg_tables where schemaname=target and tablename=any(array['delivery_settings','email_campaigns','campaign_recipients','notification_attempts','provider_events','pick_revisions','pick_requests','rule_versions','integrity_checks','incidents']) loop
 execute format('alter table %I.%I enable row level security',target,ddl);
 execute format('revoke all on %I.%I from anon,authenticated',target,ddl);
 execute format('grant all on %I.%I to service_role',target,ddl);
end loop;
for ddl in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=target and p.proname=any(array['save_pick','set_delivery_mode','claim_notifications','prepare_notification','reserve_email_slot','settle_notification','record_provider_event','expand_campaign','cancel_campaign','contest_backup','record_pick_revision','stage_notification','stage_campaign','freeze_rules','protect_frozen_rules']) loop
 execute 'revoke all on function '||ddl||' from public,anon,authenticated';
 execute 'grant execute on function '||ddl||' to service_role';
end loop;
end loop;
end $migration$;
notify pgrst,'reload schema';
commit;
