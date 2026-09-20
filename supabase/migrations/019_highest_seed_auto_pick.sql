-- Allow the tournament auto-pick rule to choose the strongest unused seed
-- line first, with AP rank as the same-seed tiebreak.

do $$
begin
  if to_regclass('public.pools') is not null then
    alter table public.pools
      drop constraint if exists pools_auto_pick_behavior_check;
    alter table public.pools
      add constraint pools_auto_pick_behavior_check
      check (auto_pick_behavior in ('latest-game', 'highest-seed', 'eliminate', 'none'));
  end if;

  if to_regclass('sandbox.pools') is not null then
    alter table sandbox.pools
      drop constraint if exists pools_auto_pick_behavior_check;
    alter table sandbox.pools
      add constraint pools_auto_pick_behavior_check
      check (auto_pick_behavior in ('latest-game', 'highest-seed', 'eliminate', 'none'));
  end if;
end
$$;
