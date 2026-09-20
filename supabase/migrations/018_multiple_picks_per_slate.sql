-- Round-level pick quotas can be spent on either playing day. A player may
-- therefore make both Elite Eight selections on the same slate. Team reuse is
-- still prevented by picks_unique_team_per_player.

alter table public.picks
  drop constraint if exists picks_player_id_slate_id_key;

create index if not exists picks_player_slate_idx
  on public.picks (player_id, slate_id);

do $$
begin
  if to_regclass('sandbox.picks') is not null then
    alter table sandbox.picks
      drop constraint if exists picks_player_id_slate_id_key;

    create index if not exists sandbox_picks_player_slate_idx
      on sandbox.picks (player_id, slate_id);
  end if;
end
$$;
