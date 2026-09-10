# Madness

Survivor pool app. Copied from the NFL Survivor codebase (`tylerherman19/NFL-Survivor`,
`main`) and pointed at its own Supabase project — the two deployments share no data.

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

`supabase/migrations/` — apply `001` through `013` in order against a blank project.
They create the `public` schema plus a mirrored `sandbox` schema used by Test Mode.

## Scripts

```bash
npm run dev      # dev server
npm run build    # production build
npm run lint     # eslint
npm test         # node --test over src/lib/*.test.ts
```
