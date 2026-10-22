# Audit: current system and evidence

Baseline: default branch `main`, commit `99166a14cb4cfed9f9f97c3d81f38e32011d5120`, fetched October 22, 2026. Earlier notes were used to locate files, not establish current production state.

| Lifecycle | Baseline implementation | Change in this branch |
|---|---|---|
| Registration/authentication | Custom password accounts; bcrypt; environment-scoped signed sessions; revocation and credential-version checks. This is not Supabase Auth. | Retain account model and one administrator login. Preview deployments require explicit confirmation of an isolated DB. |
| Manual acceptance | Synchronous API checks followed by direct insert/update; optimistic `updated_at` comparison; database integrity trigger. | Service-only `save_pick` RPC serializes each entry; atomically stores receipt, revision, audit and confirmation intent. |
| Replacement/retry | Replace in place; identical retries often returned current selection. | Browser UUID identifies one submission; replay returns its original receipt, including after lock. Different content under the same ID conflicts. |
| Deadline/reveal | First announced tip; database guard initialized comparison time before acquiring player/config/slate locks. Shared data included unrevealed teams. | Clock rechecked at acceptance after lock waits. Shared standings omit unrevealed selections and seed totals. |
| Assignment | Existing bounded batches, frozen schedule/rankings, lease tokens and expected counts; optional visitor triggers. | Consistent player-before-slate lock order; additional stale-token check; visitor assignment disabled under new worker mode. Durable picks/elimination outcomes identify completed entries; quota counts identify remaining entries. |
| Results/grading | Results sync also graded, worker ran workloads sequentially; correction replay required organizer intervention. | Independent result and grading jobs; grading stamps tied to current result; corrections invalidate stamp and create grouped incidents. No guessed reinstatements. |
| Advancement | Assignment/finals/grading guards already existed; final championship could continue searching for future days. | Explicit completed championship transition. |
| Confirmation email | Provider call awaited after accepted pick. | Transactional outbox trigger; submission never contacts provider. |
| Announcements | Long HTTP loop; 300-recipient cap; unpaged players; missing-pick audience treated any single selection as complete. | Fast durable campaign receipt; 200-row audience expansion checkpoints; per-recipient records; shared quota-aware audience. |
| Delivery | Only reminder/elimination worker; claimed 10; rebuilt content; sent/review/pending states. | Frozen request, provider idempotency, attempts, priority, expiry, shared rate gate, pause policy and explicit provider outcome. |
| Webhooks | Signature verification plus bounce/complaint suppressions. | Deduplicated append-only metadata and monotonic outcome precedence, including callbacks before HTTP acceptance persistence. |
| Recovery | Password reset sent outside transaction with its own environment switch. | Token hash and encrypted message intent recorded atomically; separate preference/expiry/switch policy; no plaintext tokens in previews. |
| Monitoring/backups | Leased operation table, encrypted application snapshot, isolated restore harness; limited admin listings. | Game/System workspaces, grouped incidents, integrity checks, new backup coverage and retention. |

## Truncation findings

Existing games/pick pagination helpers were sound but not used consistently. This branch pages remaining broad reads in dashboard/standings, grid, live scores/sweat, players, results previews, recap, history and exports. Exact SQL aggregates drive quota completion and audience counts. The API row limit is not raised.

## Production observations, October 22

- Public `/api/health` returned `{"status":"ok"}` during this investigation.
- Latest inspected [operations run 39737424239](https://github.com/tylerherman19/Madness/actions/runs/39737424239), created 06:59 UTC (1:59 a.m. Central): basic health succeeded, operations health failed HTTP 503, worker job succeeded. Its five responses reported accepted worker passes, incomplete assignment state and suppressed delivery. This is not proof that assignments should have been due.
- The prior inspected runs were created at 01:54 UTC and 23:42 UTC the preceding day. The nominal five-minute GitHub schedule was not providing five-minute invocation cadence in those observations.
- The failing health body was discarded by `curl --fail`. The exact problem code is unrecoverable from those logs. A stale worker is plausible given the invocation gaps, but not proved. `--fail-with-body`, correlation IDs and allowlisted worker logging retain usable diagnostics going forward.

## Evidence boundaries

Verified: current source, repository access, local migration execution, isolated DB behavior, localhost browser interactions, public basic health and selected workflow logs.

Not verified: which migrations are currently applied in the deployed database; its row cap, policies and extension settings; current Vercel environment values; active paid Resend configuration or domain; actual hosted throughput. The currently open Supabase organization/project was inspected but not established as the deployed Madness database. No SQL was executed there and no account setting was changed.

Existing legacy picks remain available; revision history begins with this migration. Earlier versions are not fabricated. Existing contest rules receive a baseline version when picks exist, without pretending that historical rules were recorded previously.
