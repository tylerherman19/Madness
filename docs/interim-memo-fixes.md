# Interim memo fixes — October 9, 2026

Scope follows the owner's exclusions: no result-correction replay, no everyone-loses resolution, and no email delivery activation. March Madness starts a fresh contest with new entries and unused teams. Existing prelaunch production data stays intact.

## Changes

- A restored player gets a reasoned, atomic admin override excusing their existing losing picks. Team use remains recorded. Manual picks, automatic picks, next-day access, survival counts, and subsequent grading respect those specific overrides. New losses still eliminate. Grading rechecks under the player lock so stale reads cannot undo restoration or duplicate elimination events.
- Login account throttling is scoped to account plus source IP. An attacker from another source cannot consume the legitimate player's account budget. Broader network throttling remains. Networks sharing one public IP share that source budget.
- Set Active Day calls the existing route and uses transactional database activation; an activation failure preserves the prior active day. Auto-advance uses the same activation function.
- A fresh March contest archives the prior pool, players, picks, game/slate data, and notification records in a service-only table before switching. Count verification and the entire switch run in one transaction. Existing entries, paid flags, eliminations, and used teams do not carry forward. Prior rows remain recoverable in the database archive. The admin chooses a synced future tournament opening day, supplies a reason, and types START FRESH. The expected pool ID prevents repeat clicks from archiving the newly opened contest. No rollover was executed against production.
- Deadline/quota/team-use/concurrent-write rejections return actionable 409/403 responses and do not trigger server-error alerts. Unexpected infrastructure errors still alert. Manual and automatic pick audit records come only from the existing atomic database trigger.
- Reminder runs record durable, idempotent outbox events in batches of 200 instead of sending sequentially. Reads are paged; both the application and database check the deadline. Shared-round quotas count all required picks. Post-deadline runs enqueue nothing. No delivery worker is enabled; queued means triggered, not delivered. Elimination events remain recorded in the existing outbox. Sender branding and pick-confirmation wording now match Madness.
- The pick page checks its deadline every second, refreshes every 30 seconds, disables Save at lock, and reconciles saved selections after refresh/conflict. Clock progression uses server effective time, including sandbox simulation. Public standings/grid refresh every 30 seconds while visible; mutations invalidate the affected contest pages.
- Cancel aborts admin elimination/restoration. Status changes require a reason. Admin updates record prior values and a pseudonymous session identifier. A shared password cannot attribute a session to a named human.
- Player and admin logout persist revocation of the current cookie, including copied cookies. Separate logins receive distinct token IDs. Password-change revocation remains in place. Logout failure stays visible instead of claiming success.
- Duplicate public names receive stable distinguishing ID suffixes without exposing emails. Admin tables use compact Manage disclosures, mobile cards through tablet widths, and a Survived column. Rules explicitly say that the server must save a pick before the deadline.

## Validation

- 50 unit tests, TypeScript, ESLint, production build, and diff whitespace checks.
- Isolated PostgreSQL/PGlite rehearsals of repository migrations through 023 in public and sandbox. Restoration, new-loss enforcement, stale grading, one atomic pick audit, reminder batches for 1,200 entries, repeat/expired reminders, protected tables/functions, archive content/counts, and failed/repeated rollover are checked. This is an isolated database rehearsal, not a production concurrency/load certification.
- Real local route tests with fake database/test-only credentials: player and administrator copied-cookie replay succeeds before logout and is denied afterward; a separate login remains valid.
- Browser checks using local fixture components: Save disables at deadline, Cancel produces zero mutation requests, and desktop/390px admin views fit the viewport. Temporary fixture routes are removed from the release.

## Rollout

1. Preserve a current production backup. Apply **only** `023_interim_memo_fixes.sql` to the database that already has 022. Never replay 014 against production.
2. Verify the new tables/functions exist in public and sandbox, are restricted to service_role, and do not change existing participant/pick counts. Deploy the application afterward; session verification and pick/grading reads depend on 023.
3. Verify production Ready, public pages, auth/admin guards, and test-only player restoration/picking/logout. Keep EMAILS_ENABLED disabled and do not invoke the fresh-contest action until the owner starts March.

The October 8 memo's cleanup plan is documentary history, not an instruction to delete current prelaunch data. The public live standings were checked October 9 and still contained the test cohort. No exact original-state restoration was attempted without the referenced backup. Postponement/cancellation policy and individual administrator accounts remain owner decisions rather than invented rules.
