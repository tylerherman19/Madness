# Verification evidence

Environment: local macOS, Node 24.11.1; source branch `codex/tournament-reliability`. No production load, test email, production SQL mutation, purchase, merge or production deployment was performed.

| Check | Evidence |
|---|---|
| TypeScript | `npx tsc --noEmit` passed. |
| Unit regressions | 64 tests passed, including isolated workflow retry shells. |
| Legacy database regressions | Public and sandbox tests passed for restoration, 1,200 recipients, archive integrity, role restrictions. |
| Legacy operations/restore | Claims, stale workers, partial assignment recovery, backoff, notification fencing and encrypted isolated restore passed. |
| Full-chain tournament schema | 2,000 entries in **each** schema. Transactional pick receipts/replay, stale edits, quotas, frozen rules, resumed campaign expansion beyond 1,000 rows, held backlog protection, priority, stale delivery leases, frozen requests, out-of-order/deduplicated callbacks, late job invocation and role restrictions passed. |
| Grading/corrections/completion | Full-chain suite checks ungraded losing picks block a grading stamp; authoritative grading permits it; correction clears it and creates an incident; championship completes explicitly. |
| Full new backup restore | 23 application tables, 6,037 fixture rows restored with matching row digests. No live data was used. |
| Mocked provider | Kill switch, record-only behavior, accepted-but-response-lost, immutable retry payload/key, 429, permanent rejection and configuration/quota pause passed. This does not prove actual Resend performance/delivery. |
| Real PostgreSQL concurrency | Disposable localhost PostgreSQL from workspace-only embedded runtime: 50 simultaneous identical retries produced one pick; competing stale edits, independent-player writes and a player-lock wait crossing the deadline passed. No deadlock observed in this test. This is not exhaustive deadlock/capacity proof. |
| Browser | 12 browser tests passed in 18.2 seconds. Desktop and 390px mobile navigation, authorization, campaign receipt, disabled live activation, real empty states, signup/login/recovery/preferences, signed callbacks and saved-pick flows. Screenshots inspected. Lost-response reconciliation also passed with one POST and one durable accepted pick. |
| Production build | `next build --webpack` passed with network access for the repository's existing Google Fonts. Sandboxed font fetch failed; a sandboxed Turbopack invocation stalled and was stopped. |
| Runtime advisories | Current `npm audit --omit=dev` returned zero vulnerabilities. No forced dependency upgrade applied. |

## Remaining release gates

- Applied production migrations, privileges, project identity and effective environment switches have not been verified against the deployed database.
- No hosted 1,000-viewer or deadline-burst capacity test has been run. The 2,000-row migration suite is functional evidence, not hosted performance.
- No paid Resend account/key/domain, real allowlisted send, successful delivery callback or 1,000-message drain time is verified. User intends paid Resend but it is not connected or enabled.
- Supabase Cron/Vault/pg_net scheduler configuration is provided but not activated. Verify project resource use, responses and cadence before a tournament.
- The existing application snapshot/restore protects data. Complete hosted disaster recovery, including cron, secrets and deployment configuration, remains an operating rehearsal.
- Missing/TBD/canceled schedules, absent pre-lock rankings and uncertain provider outcomes require review. They are not silently repaired.
- Real DB race tooling covers the tested acceptance cases. Broader hosted stress combinations (schedule writes + admin corrections + assignment over many rounds), long fault-injection runs and provider-account throttling remain staging scenarios.

The implementation must not be described as proven ready for 1,000+ live players until these release gates are satisfied.
