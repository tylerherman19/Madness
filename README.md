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
| `ALERT_SMS_TO` | Where failure texts and the daily summary go, e.g. `5551234567@tmomail.net` (T-Mobile email-to-SMS). Comma-separate for several. Sent as email, so nothing goes out until `EMAILS_ENABLED=true` |
| `NEXT_PUBLIC_APP_URL` | Base URL used in links |

## Database

`supabase/migrations/` — apply `001` through `021` in order against a blank project.
They create the `public` schema plus a mirrored `sandbox` schema used by Test Mode.

- `020` turns row-level security back on for `slates`, `teams`, `games`, `picks`
  and `pools` (014/017 had left it off, exposing them to the anon key). The app
  uses the service role key, which bypasses RLS, so nothing else changes.
- `021` adds per-slate sync/auto-assign bookkeeping and the
  `claim_slate_auto_assign()` function. The app runs without it, but first-tip
  auto-assign stays off until it is applied (the daily cron still runs).

Large reads (a season's games and picks) are paged through `src/lib/db.ts`:
PostgREST silently caps every response at 1,000 rows by default.

## Scheduled jobs

| Job | When |
| --- | --- |
| Auto-assign missed picks | After the active day's first tip — the enabled durable worker processes bounded batches without visitors. Page requests and the 06:00 UTC cron (1 AM CDT / midnight CST) remain backstops. |
| Sync results + grade | 07:00 UTC (2 AM CDT / 1 AM CST); overdue unfinished days remain eligible for reconciliation. |
| Advance to the next game day | Starts at 3:00 AM Central (08:00/09:00 UTC entries cover DST). The enabled worker retries delayed turnover later that day; skips days without games. |
| Reminders | Enabled worker queues events in the 2-hour and 30-minute pre-lock windows. Separate delivery switches must be enabled to send. Legacy 15:00 UTC queue remains a fallback when v2 is off. |
| Daily summary text | 13:00 UTC (~7–8 AM Central): last 24h of picks, eliminations, signups and failures |

The overnight backstops run before either turnover entry so moving turnover
earlier does not race the old slate's missed-pick assignment. These times
are scheduled targets, subject to the hosting plan's execution precision.
Turnover requires final results, completed assignment and grading before
transactional activation. Reminder and elimination delivery also requires
`OUTBOX_DELIVERY_ENABLED=true`; this release leaves it off.

## Audit log and failure alerts

**Admin → Audit** shows what players and admins did and what failed. Failures
(scheduled jobs, ESPN syncs, any API 500, uncaught crashes via
`src/instrumentation.ts`, failed email sends) are reported through
`reportFailure()` in `src/lib/alerts.ts`, which writes a `job-failed`,
`server-error` or `email-failed` row and texts `ALERT_SMS_TO`.

- Repeats of the same failure within 10 minutes collapse into one row.
- At most one text per failure type per 30 minutes.
- Test-mode (sandbox) failures go to the sandbox trail and never text.
- Texts ride the normal email path, so they stay off until email is enabled.
  The audit page's **Send test text** button reports why a text didn't go out.

Cron routes accept `GET` with the `CRON_SECRET` bearer token only. The admin
buttons call the same routes with `POST` and the admin session, so a link
can't trigger a job through the admin's cookie.

ESPN is polled for the ACC, Big East, Big Ten, Big 12, SEC, Pac-12 and the NCAA
tournament.

## Scripts

```bash
npm run dev      # dev server
npm run build    # production build
npm run lint     # eslint
npm test         # node --test over src/lib/*.test.ts
```

## Launch and operations

Legal/contact pages, social metadata, crawler files, and branded fallback screens ship with the app. See [deployment checks](docs/operations.md) for the primary domain, support contact, Vercel analytics enablement, read-only health monitoring, and data export/backup guidance.

## Operational reliability

See [the operational release guide](docs/automation-release.md) for the new worker,
fenced assignment/retry state, signed delivery callbacks, notification preferences,
encrypted backup/restore drill, retention policy and deployment prerequisites.
Migration 024 and explicit feature activation are required before the durable
worker or delivery queue runs. Existing daily backstops remain configured.

Validation: `npm test`, `npm run test:db`, `npm run test:operations`,
`npm run test:e2e`, `npm run lint`, `npm run build`. Browser fixtures use
synthetic data on loopback ports; `npx playwright install chromium` is required.
