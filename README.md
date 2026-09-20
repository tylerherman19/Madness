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

- **No email.** `getResend()` in `src/lib/email.ts` returns a stub that logs and
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
| `CRON_SECRET` | Authenticates Vercel cron requests |
| `NEXT_PUBLIC_APP_URL` | Base URL used in links |

## Database

`supabase/migrations/` — apply `001` through `017` in order against a blank project.
They create the `public` schema plus a mirrored `sandbox` schema used by Test Mode.

## Scripts

```bash
npm run dev      # dev server
npm run build    # production build
npm run lint     # eslint
npm test         # node --test over src/lib/*.test.ts
```
