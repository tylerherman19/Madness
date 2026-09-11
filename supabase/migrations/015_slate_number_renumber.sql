-- `slate_number` is a display index ("Day 12"), derived from date order, not
-- an identity. Whenever a new day is synced the whole season renumbers so the
-- sequence stays chronological even when days are synced out of order.
--
-- That renumbering pass rewrites many rows at once and cannot avoid transient
-- duplicates partway through, so the uniqueness constraint has to go. It was
-- never the real key anyway: (slate_date, season_year) is, and it stays.

alter table slates drop constraint if exists slates_slate_number_season_year_key;
alter table sandbox.slates drop constraint if exists slates_slate_number_season_year_key;

-- Ordering the season by date is the only query that reads it.
create index if not exists slates_season_date_idx on slates (season_year, slate_date);
create index if not exists sandbox_slates_season_date_idx on sandbox.slates (season_year, slate_date);
