-- Games whose tip time hasn't been announced yet.
--
-- ESPN publishes a full season schedule months ahead, but with placeholder
-- times: the event date is midnight Eastern and `timeValid` is false. Those
-- placeholders are poison for two rules that key off tip time:
--
--   * Which day a game belongs to. Midnight ET is 11pm Central the *previous*
--     day, so filing by Central tip date put the entire 2026-27 season one day
--     early — opening night landed on Sunday Nov 1 instead of Monday Nov 2.
--   * When the slate locks. `locks_at` is the earliest tip, so a single TBD
--     game would lock the whole day at 11pm the night before.
--
-- Recording the flag lets both rules ignore placeholders: a TBD game is filed
-- by its Eastern date (which is the intended playing date) and excluded from
-- the lock calculation, and the UI can say "TBD" instead of inventing 11pm.

alter table games add column if not exists time_tbd boolean not null default false;
alter table sandbox.games add column if not exists time_tbd boolean not null default false;
