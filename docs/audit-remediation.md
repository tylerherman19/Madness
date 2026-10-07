# Independent audit remediation — October 7, 2026

User scope: skip F16 and the 600-session load test. Unpaid entries remain eligible. Late automatic assignment may choose a started or completed game, but the choice must use the frozen deadline-time schedule, never outcomes.

## Application release

- Signup uses a clear account-creation terms/privacy notice and requires no checkbox or `terms_accepted` field.
- Email uniquely identifies login candidates; ambiguous normalized email matches cannot authenticate. JWT purpose, HS256 algorithm, issuer and environment audience are checked. Password changes revoke player sessions through a keyed credential-version check. Existing cookies require sign-in again. Individual admin accounts/MFA remain a separate project.
- Account limits accompany broader network limits, so a shared Wi-Fi network is less likely to block legitimate entrants. Pick changes have their own participant limit.
- Unknown deadlines and database/rule-read errors cannot open pick submission/registration. Deadlines take the earlier of published lock and current first announced tip; schedule refresh never silently extends a published lock. Live scores use the stored slate membership and published tip times, with provider scores overlaid.
- Grading reads are paged, writes fail explicitly, distinct player IDs track advancement, and notifications do not pace grading. Stored completed results on overdue slates are revisited, including inactive days; provider recovery work is bounded to four dates per invocation. Persisted job cursors/fair rotation for permanently unresolved games still need work.
- Unsupported weekend-only, per-game deadline and team-reuse options are removed/rejected. Material rule changes are refused after accepted picks. Pool lifecycle/start-date fields remain display metadata and do not promise enforcement.
- Production reset is disabled pending a verified archive/recovery workflow. No real entries were reset or modified during this work.
- Completed qualifying periods count toward survival, not pending picks or selections. All required picks must win. The homepage labels paid-flag × $25 as an estimate and shows paid/pending entries. This is not a financial ledger, refund reconciliation or payout authorization.
- Preseason/date labels, guest join/sign-in actions, days/hours countdown and champion completion checks are corrected.
- Next.js and its ESLint config are patched to 16.4.0; transitive advisories are patched. Node typings/CI match Vercel Node 24. Lint is required. Unused duplicate odds files are removed.

## Database-dependent follow-up

Migration `022_competition_integrity.sql` is additive and has been rehearsed against isolated PostgreSQL with all preceding repository migrations. **Only apply migration 022 to the existing production database. Never replay migration 014 there; it is destructive legacy setup.**

022 adds serialized pick quota/reuse/deadline/eligibility enforcement covering both manual and automatic writes, normalized email uniqueness, atomic pick audit records, a frozen assignment schedule, transactional slate activation, and an elimination notification outbox. It does not delete entry history. A normalized-email collision aborts the transaction and must be resolved with the owners before retrying.

Review a backup and run the migration on a separate staging project first. Verify daily and shared-round concurrency, deadline crossing, retry and database failure behavior. Local database checks passed; isolated Supabase staging and production application are not verified yet. Existing locked days receive a migration-time recovery baseline, not a retroactively reconstructed lock-time snapshot.

The follow-up application PR uses the snapshot for late assignment, handles assignment in 50-entry batches, blocks advancement until results/assignment/grading complete, and calls transactional activation. Deploy that PR **after** the migration is applied and verified. Email remains disabled; the outbox has no activated delivery worker and must not be treated as delivered mail. A complete durable job/outbox worker with retry, fencing and dead-letter handling remains necessary before enabling bulk email.

## Infrastructure changes and remaining evidence

Production Supabase URL/service credential, session secret, admin hash, cron secret and email API credential are no longer injected into new previews. Vercel authentication protects previews and fork protection is enabled. Separate staging credentials/projects and credential rotation remain outstanding; existing deployments retain the credentials embedded at their build time.

F12 requires actual RLS/grant evidence, backup restoration and external alert drills. Repository SQL alone cannot prove the live database configuration. F11 still needs versioned result corrections, manual-result priority and reviewed eligibility replay; current eliminated entries are not automatically reinstated by a correction. F13 is deferred before a second competition: identities/eligibility/picks still lack dedicated pool-entry scope. F18 requires owner-approved postponement, void-game, outage, dispute, refund and payout policies plus a payment ledger. These business decisions are not silently invented in code.

F16 is intentionally untouched. No 600-session load test, email send, paid-plan upgrade or production participant mutation was performed.

## Supabase free tier

Published pricing checked October 7: 50,000 MAU, 500 MB database, shared CPU/500 MB RAM, 5 GB egress, 200 concurrent Realtime peak connections. 600 registered users fit the account quota. This app uses HTTP rather than Realtime, so browser sessions are not 1:1 database connections or Realtime sockets. Cached viewing and modest submissions may fit, but 600 simultaneously active users/deadline bursts are not a performance guarantee on shared free compute. No capacity certification is claimed. Source: https://supabase.com/pricing.
