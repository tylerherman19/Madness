# Madness

A college basketball survivor platform. It runs two competitions off one engine
and one UI: a **regular-season** pool played over NCAA game days, and a **March
Madness** pool played over tournament rounds. The brand is MADNESS year-round.

Copied from the NFL Survivor codebase (`tylerherman19/NFL-Survivor`, `main`) and
pointed at its own Supabase project — the two deployments share no data.

## Competition modes

The survivor mechanic is identical in both modes: one pick per **pick period**,
a team can't be reused, a win advances, a loss eliminates, picks lock at the
period's deadline, last entry standing wins. What changes is what the product
shows and what it calls things.

| | Regular Season | March Madness |
| --- | --- | --- |
| Pick period | a calendar day — "Saturday, January 24" | a round day — "First Round · Thursday" |
| Supporting line | College Basketball Survivor | Tournament Survivor |
| Seeds / regions / rounds | hidden | shown |
| Schedule grouped by | date | round |
| Pick history labelled by | date | round |
| Team context | AP Top 25 position | tournament seed |

The mode is an administrator setting stored on the pool, configured at
**Admin → Pool Configuration**. It is never inferred from the calendar month,
and switching it never deletes players, picks or history — it only reorganises
how the same survivor record is displayed.

Three modules carry the whole system:

- `src/lib/competition.ts` — pure, shared by server and client. Capabilities
  (`showSeeds`, `groupScheduleByRound`, …), terminology, the tournament round
  vocabulary, and `buildPickPeriods()`, which turns slates plus games into the
  labelled pick periods every page renders.
- `src/lib/pool.ts` — server-side read/write of the active pool's config.
  Falls back to regular-season defaults when no pool row exists, so the app
  still renders before `017` is applied.
- `supabase/migrations/017_pool_configuration.sql` — the `pools` table.

Components consume the capability/copy objects rather than testing the mode
inline. Adding a mode-dependent behaviour means adding a capability, not
another conditional.

## Differences from NFL Survivor

- **No email.** `getResend()` in `src/lib/email.ts` returns a stub that
  discards every send unless `EMAILS_ENABLED=true`. The `/api/cron/reminders` job
  still runs on schedule; it just has nothing to deliver.
- Separate Supabase project, separate Vercel project.
- In-app copy, logos, and `pickandpray.org` links are unchanged from the original.

## Local setup

```bash
npm install
cp .env.example .env.local   # fill in the values
npm run dev
```

## Environment

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side DB access (bypasses RLS) |
| `SESSION_SECRET` | Signs session cookies — `openssl rand -base64 32` |
| `ADMIN_PASSWORD_HASH` | bcrypt hash of the admin password |
| `RESEND_API_KEY` | Unused while `EMAILS_ENABLED` is off |
| `EMAILS_ENABLED` | Must be exactly `true` to send mail. Anything else = silence |
| `PASSWORD_RESET_EMAILS_ENABLED` | Also must be exactly `true` to deliver password reset links. Defaults to off. |
| `CRON_SECRET` | Authenticates Vercel cron requests |
| `NEXT_PUBLIC_APP_URL` | Base URL used in links |

## Database

`supabase/migrations/` — apply `001` through `022` in order against a blank project.
They create the `public` schema plus a mirrored `sandbox` schema used by Test Mode.

- `020` turns row-level security back on for `slates`, `teams`, `games`, `picks`
  and `pools` (014/017 had left it off, exposing them to the anon key). The app
  uses the service role key, which bypasses RLS, so nothing else changes.
- `021` adds per-slate sync/auto-assign bookkeeping and the
  `claim_slate_auto_assign()` function. The app runs without it, but first-tip
  auto-assign stays off until it is applied (the daily cron still runs).
- `022` adds `slates.graded_at`, which marks a game day fully graded. With it,
  the results job also catches up any earlier day a failed run left ungraded
  (see Scheduled jobs). The app runs without it; the job then grades the active
  day only, as before. Applying it marks every day before the active one as
  already graded, so it never re-grades history.

Large reads (a season's games and picks) are paged through `src/lib/db.ts`:
PostgREST silently caps every response at 1,000 rows by default.

## Scheduled jobs

| Job | When |
| --- | --- |
| Auto-assign missed picks | Minutes after the active day's first tip — triggered by the live ticker, sweat board and pick page (`src/lib/autoAssign.ts`). The 08:00 UTC cron is a backstop for a day nobody visits. |
| Sync results + grade | 09:00 UTC. Covers the active day and any earlier day of the season that isn't fully graded yet — so a night ESPN was down is caught on the next run (`src/lib/settle.ts`). A day is marked graded once all its games are decided; after that it is never re-graded automatically, so an admin's restore sticks. Admin → Results has a "Sync results & grade now" button for the same job. |
| Advance to the next game day | 6:00 AM Central (two UTC entries cover DST). Grades the outgoing day first, as a second chance for the 09:00 UTC run. |
| Reminders | 15:00 UTC (no-op while email is off) |

Cron routes accept `GET` with the `CRON_SECRET` bearer token only. The admin
buttons call the same routes with `POST` and the admin session, so a link
can't trigger a job through the admin's cookie.

ESPN is polled for the ACC, Big East, Big Ten, Big 12, SEC, Pac-12 and the NCAA
tournament.

A game day runs from 6:00 AM to 5:59 AM Central (`src/lib/gameDay.ts`), matching
the daily advance. A tip after midnight — a 10 PM Pacific start, a Hawaii game —
belongs to the evening it is played in, so it can never become the next day's
first tip and lock that whole day overnight.

## Scripts

```bash
npm run dev      # dev server
npm run build    # production build
npm run lint     # eslint
npm test         # node --test over src/lib/*.test.ts
```

## Launch and operations

Legal/contact pages, social metadata, crawler files, and branded fallback screens ship with the app. See [deployment checks](docs/operations.md) for the primary domain, support contact, Vercel analytics enablement, read-only health monitoring, and data export/backup guidance.
