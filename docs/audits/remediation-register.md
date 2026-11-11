# Remediation register and shared contracts (working document)

Source audit: `2026-11-10-production-readiness-audit.md` (commit `42f71ef`). Branch: `remediation/2026-11-10-audit`.
Owner instructions override the audit's "Fix" lines. This file is the orchestrator's source of truth; agents update only their own rows.

## Baseline (before any change, 2026-11-10, PGlite, laptop)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `npm test` | pass |
| `npm run lint` | pass |
| `npm run test:db`, `test:operations`, `test:tournament` | pass |
| `npx next build` | pass |
| `npm run test:e2e` | failed to start (F-19, space in path); 12/12 after the config fix |

No real PostgreSQL, Docker, `gh` or Supabase CLI on this machine. No staging Supabase project exists; the `sandbox` schema lives in the production database and is not an isolated target.

## Hard exclusions (every agent)

Do not touch: Madness Intelligence (`madness_intelligence_snapshot`), email delivery (stays disabled; no email alerts), the other survivor league, production (no deploys, migrations, load), published participant rules copy (`RulesSection.tsx` text), the shared admin password and its attempt limits, public signup policy and limits, conference coverage, visual identity, dependency or framework upgrades, broad refactors. No automatic winner or co-winner logic. No payout or champion records. Never run `stress-test.mjs`.

## Shared contracts

### Migrations
Numbers are pre-assigned; never create a number you do not own. Follow the existing style: a `do $migration$` loop over `public` and `sandbox` with `__SCHEMA__` replacement, idempotent (`if not exists`, `create or replace`), `notify pgrst, 'reload schema'`, revoke from `public, anon, authenticated` and grant to `service_role`. Additive only; no deletes of existing rows.

| No. | Owner | Purpose |
|---|---|---|
| 030 | WS-A | Independent contests |
| 031 | WS-B | Results/team identity (only if needed) |
| 032 | WS-C | Password reset link, auth |
| 033 | WS-D | Native (mobile) API reconciliation |
| 034 | WS-F | Game resolution, corrections, zero-survivor stop |
| 035 | WS-H | Monitoring, stall detection |
| 036 | WS-G | Performance (indexes, aggregates) |

### Contest model (WS-A defines, everyone else consumes)
- A contest is a row in `pools`. Exactly one is active (`pools_one_active_idx`). Regular season and March Madness are separate rows.
- `players.pool_id uuid not null references pools(id)`: an entry belongs to exactly one contest. Backfill: every existing player gets the currently active pool (or the most recent pool if none is active).
- `picks.pool_id uuid not null`: always equals the entry's `pool_id`; set by trigger, never trusted from the client.
- Email uniqueness becomes per contest: unique `(pool_id, lower(btrim(email)))`. The same person may hold an entry in each contest.
- Slates and games remain a shared schedule. A contest's days are those on or after `pools.starts_on` and (for archived contests) on or before `pools.ended_on`.
- Starting March Madness archives the old pool (`is_active=false`, `status='archived'`, `ended_on` set) and creates a new pool. It deletes nothing. A JSON snapshot is still written to `contest_archives` as a recovery copy.
- Deleting an archived contest is a separate RPC that refuses the active contest, requires the exact contest name and a reason, writes a snapshot first, and audits.
- Helper every reader uses: `src/lib/pool.ts` exposes the active pool; every query against `players` or `picks` for live gameplay filters by the active `pool_id`. SQL functions use `(select id from __SCHEMA__.pools where is_active)`.
- Player status, team reuse, quotas and elimination are evaluated only within the entry's own contest.

### Contest state (WS-F implements; no winner logic)
`pools.status` stays within the existing check constraint. New derived state from one SQL function `contest_state()` returning jsonb: `{registered, alive, eliminated, started, survivors_meaningful, stopped}`.
- `started`: regular season = first game of the contest has tipped; March Madness = every Round 1 game is final and graded.
- `survivors_meaningful = started`. Before that the UI shows registered entries, never a survivor outcome.
- `stopped`: `started` and `alive = 0` and `registered > 0`. When stopped: no automatic advancement, no new picks, standings preserved, no winner. Restoring an entry clears it.
- One survivor: nothing special happens.

### Reveal rule (WS-B)
One function decides whether other entries' picks for a slate are visible: `isPickRevealed(slate, dbGames, now)` in TypeScript and `app_private.slate_is_revealed` in SQL, both meaning "the database lock time has passed". ESPN status never reveals.

### Test ports
`E2E_APP_PORT` and `E2E_DB_PORT` override 3017 and 54329. Each agent uses its assigned pair.

## Workstreams

| WS | Scope | Phase | Agent ports |
|---|---|---|---|
| A | Independent contests (7.3), archive deletion | 1 | 3117 / 54429 |
| B | F-04 reveal, F-05 result parsing, D-4 rankings, F-17 team identity, F-29 page-view writes | 1 | 3217 / 54529 |
| C | F-02 password reset link, F-28 session secret, F-15 rate limits, F-08 backups | 1 | 3317 / 54629 |
| E | F-13 Grade button, F-16 local time zone, UX-2 standings, F-18 | 1 | 3417 / 54729 |
| D | F-03 native API, second auth system (5.2, 5.3) | 2 | 3517 / 54829 |
| F | Game admin controls, corrections, stalled games, zero-survivor state (4.1, 4.4–4.6) | 2 | 3617 / 54929 |
| H | Monitoring (7.1), safer admin actions (7.4) | 2 | 3717 / 55029 |
| G | Performance (Part 6), load tests | 2–3 | 3817 / 55129 |

## Finding register

Status values: Fixed and independently verified / Fixed but not fully verified / Partially fixed / Blocked / Excluded by owner / No longer applicable.

| ID | Approved behaviour | WS | Status | Files | Tests | Verified by | Limits / owner action |
|---|---|---|---|---|---|---|---|
| F-01 | No winner logic; thresholds; zero-survivor stop | F | Not started | | | | |
| F-02 | Admin-generated one-time reset link, no email | C | Not started | | | | |
| F-03 | Native API in source control, reviewed | D | Not started | | | | |
| F-04 | Single reveal rule | B | Not started | | | | |
| F-05 | Never fabricate a winner | B | Not started | | | | |
| F-06 | Query efficiency, caching, load test (no upgrade) | G | Not started | | | | |
| F-07 | Monitoring without email | H | Not started | | | | |
| F-08 | Private backup storage | C | Not started | | | | |
| F-09 | Shared admin password | — | Excluded by owner | | | | |
| F-10 | Signup policy | — | Excluded by owner | | | | |
| F-11 | Independent contests, no delete | A | Not started | | | | |
| F-12 | Corrected results restore/eliminate | F | Not started | | | | |
| F-13 | Grade button works | E | Not started | | | | |
| F-14 / D-1 / D-2 | Void/replace/manual, stall detection | F, H | Not started | | | | |
| F-15 | Shared-network rate limits | C | Not started | | | | |
| F-16 / UX-1 | Local time zone, CT fallback | E | Not started | | | | |
| F-17 | Stable ESPN team ids | B | Not started | | | | |
| F-18 | Remove other-league stress test | E | Not started | | | | |
| F-19 | e2e with a space in the path | Orchestrator | Fixed (12/12 e2e pass from a path with a space) | `playwright.config.ts`, `tests/*` | e2e | Not independently reviewed | |
| F-20–F-26 | Email | — | Excluded by owner | | | | |
| F-27 | Paid tier | — | Excluded by owner | | | | |
| F-28 | Session secret minimum strength | C | Not started | | | | |
| F-29 | Page views must not write | B | Not started | | | | |
| D-3 | Conference coverage | — | Excluded by owner | | | | |
| D-4 | No alphabetical fallback | B | Not started | | | | |
| UX-2 | Standings at 1,000 rows | E | Not started | | | | |
| UX-3, UX-4, UX-5 | Touch targets, zero-alive copy, saved time | — | Excluded by owner | | | | |
| UX-6 | Rules copy vs behaviour | — | Report only; rules not edited | | | | |
| UX-7 | Safer admin actions | H | Not started | | | | |
| 7.5 | Backup restore drill | C | Not started | | | | |

## Production facts gathered read-only (2026-11-11, Supabase dashboard, catalog SELECTs only)

- All 20 mobile-API functions in production (`public.submit_pick`, `get_slate_picks`, `get_entry_picks`, `get_standings`, `get_my_entries`, `get_pool_summary`, `auth_user_id_by_email`, `register_push_device`, `unregister_push_device`, `get_notification_preferences`, `save_notification_preferences`, `server_now`, and eight `app_private.*` helpers) have bodies identical, ignoring whitespace and comments, to `supabase/migrations/020_native_app.sql` and `021_pool_summary_own_entries.sql` on the `native-ios` branch (checksum comparison of `pg_proc.prosrc`). The source exists; it was never merged to `main`, and its numbers collide with main's 020/021.
- `public.rls_auto_enable()` is an event-trigger function (trigger `ensure_rls`, `ddl_command_end`) that enables RLS on new `public` tables. It returns `event_trigger`, so it cannot be called as an RPC even though `anon` holds EXECUTE.
- `anon` and `authenticated` have no USAGE on schema `app_private`.
- Execute grants: the ten client RPCs are granted to `authenticated` and `service_role`; `auth_user_id_by_email` to `service_role` only; `madness_intelligence_snapshot` to `anon` (not inspected further, out of scope).
- Supabase Auth: "Allow new users to sign up" is OFF, anonymous sign-ins OFF, confirm email ON.
- Row counts: `auth.users` 1, `player_accounts` 0, `push_devices` 0, `notification_preferences` 0, `players` 1, `picks` 4, `contest_archives` 0, one pool (`MADNESS`, regular-season, live, active).
