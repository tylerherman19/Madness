# Madness remediation report

Date: 2026-11-12. Audit addressed: `2026-11-10-production-readiness-audit.md` (commit `42f71ef`).
Branch: `remediation/2026-11-10-audit`. Nothing has been deployed and no production data or setting was changed.
All results below are from local tests. They do not prove production readiness.

## What was fixed

Participant-facing
- Picks no longer leak before the lock on the Today page; one reveal rule (the earlier of the stored lock and the first announced tip) is used by every page, feed, export and the mobile API (migration 034).
- A surviving entry can pick for the next day early.
- A result that flips A→B→A leaves only the entries that lost under the final result eliminated.
- Neutral-site games show the right teams; games with other than two competitors are not stored.
- Deadlines show in the visitor's own time zone with a label.
- Standings stay usable at 1,000 entries (100 rows at a time, own row pinned).
- No automatic winner or co-winner is declared or displayed. One survivor plays on normally; with zero survivors the contest stops accepting picks and stops advancing.

Admin-facing
- The Grade button works.
- Results can be set, corrected, voided or released with a reason; an admin result is never overwritten by ESPN; a void eliminates nobody.
- A "Needs attention" list shows postponed, cancelled and stalled games.
- `/admin/operations` shows whether each automated job is running on time.
- Changing the active day is refused when it would skip auto-assignment, unless overridden with a reason.
- Password recovery by one-time link issued by the admin (60 minutes, single use, no email).
- Incident reports no longer repeat for the same problem.

Performance (kept)
- Database calls per request, local, 1,000 entries: signed-out home 3 → 0 when warm (102 → 0 late in a season); signed-in home 6 → 3; `/api/me` 6 → 3; repeated export 11–101 → 0. Home payload 239 KB → 122 KB. Page views no longer write to the database.

Removed at the owner's direction: independent contest seasons, history pages, archive/delete.

## Test results

| Suite | Result |
|---|---|
| Typecheck | clean |
| Lint | 0 errors, 3 unused-variable warnings |
| Unit (`npm test`) | 135 pass, 0 fail |
| `test:db` | 6 pass |
| `test:operations` | 20 pass |
| `test:tournament` | 12 pass |
| `test:resolution` | 18 pass |
| Browser (Playwright) | 43 pass, 0 fail |

Tournament simulation, 1,000 entries on a real local PostgreSQL (`docs/audits/evidence/simulation-run.txt`): 115 checks, 0 failed.
It covered registration and sign-in, picks and changes, quotas and reuse, privacy before lock, lock, auto-assignment (exactly once, matching the rule), overtime/postponed/corrected results, void and manual results, early next-day picks, eliminated entries refused, rounds 2 through the championship, one survivor finishing, zero survivors stopping, and the job-health page.
Caveats: 900 of the 1,000 entries were inserted by SQL (100 registered through the site); the field was cut to one survivor by SQL before the Final Four; the full run was made on a Thursday.

Independent review (one pass over the whole branch): no critical defects and no pick-privacy leak found. Two small items were fixed afterwards, with tests: an elimination whose reason the admin has edited is no longer auto-restored by a later correction, and internal test accounts no longer keep a contest from stopping.

## Accepted, unresolved limitation: pick-rush capacity

In a local test with one server process, 1,000 entries submitting within 2 minutes while 250 browsed succeeded 58% of the time (42% within 30 seconds). Browsing was clean at 100 concurrent visitors and failed increasingly from 250. No duplicate pick, no pick after lock and no success without a stored row occurred.
The owner has accepted this and may address it with backend capacity. **1,000 simultaneous submissions are not supported or claimed.** Production capacity was not measured. Unfinished optimisation work is kept, unmerged and unreviewed, on branch `p1-rush`.

## Other remaining items

- The published rules still say the final survivor "wins" and that tied entries "share the win". The app no longer declares a winner. The rules text was not changed.
- The Vercel project could not be accessed: the feature flags (`TOURNAMENT_RELIABILITY_ENABLED`, `AUTOMATION_V2_ENABLED`) and the strength of `SESSION_SECRET` in production are unchecked. A weak secret only produces a warning.
- The mobile app's pick functions are not in this repository. Migration 034 changes the two helper functions found in production; that the mobile pick and reveal functions all go through those helpers was not confirmed from source.
- Backups are unchanged from before (encrypted artifacts, publicly reachable).
- Two-day rounds decide their final day from the weekday of the game date (existing behaviour, unchanged).

## Deployment steps (need the owner's approval)

1. Back up the database.
2. Apply migrations `032`, `033`, `034` in order, **before** deploying the code. They are additive and safe under the current code. If the code is deployed first, ESPN sync fails until `033` is applied.
3. Deploy the branch.
4. Check `/api/health` and `/admin/operations`, then grade and pick once in the sandbox.
