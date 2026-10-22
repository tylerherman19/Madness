# Contest rules and exception policy

Preserved rules come from the active `pools` row and existing competition functions, not a simplified new game. The effective configuration freezes at the first pick; existing picked contests receive a clearly marked baseline version. Each new revision references its applicable rule version. Normal rule changes after freeze are rejected; deliberate amendments require reviewed engineering/database work and an explanation. Operational name/status changes remain possible. The existing archive-and-start-fresh workflow creates a new contest boundary; this branch never executes it.

| Rule | Policy |
|---|---|
| Periods | Existing daily mode and tournament round mode. Elite 8 shares its quota as before. |
| Quotas | Two for rounds 1/2, Sweet 16 and Elite 8 in round-quota behavior; one otherwise, using canonical round labels. |
| Reuse | Once per pool; DB unique logical selections plus stable ESPN team identity when provided. Unknown legacy identity is not invented. |
| Deadline | Earliest published lock / announced first tip. No acceptance if unknown. After relevant lock waits, time must still be strictly before deadline. Reaching the API before lock is insufficient. Commit may complete later if the authoritative acceptance decision occurred before lock. |
| Early next day | Existing winning entrants may access the first next playing day after the current lock, within the existing ten-day search horizon, with shared-round quota guards. DB now checks stored authoritative results; a transient browser feed alone cannot grant eligibility. |
| Reveal | Team selections and their seed totals are omitted from shared standings before their period lock. Participation counts may be public. |
| Automatic selection | Existing latest-game / highest-seed algorithm and tiebreak behavior. Pre-lock stored schedule and rankings are required; missing frozen inputs require review. Results are not ranking inputs. |
| Missing selections | Apply the configured automatic/eliminate/none rule at the appropriate final day of a shared round. Partial quotas count as incomplete. The `none` rule intentionally leaves missing selections for organizer review. |
| Overrides | Existing authenticated administrators, same access to both workspaces. Pick corrections require reason and expected version. Session-derived actor ID is stored; the current shared admin account does not establish a person's legal name. |
| Cancellation/postponement/TBD | Do not invent winners or silently extend an announced lock. Pending/unknown games keep grading/advancement waiting. Review schedule changes deliberately; no new automatic void/refund rule is invented. |
| Result correction | Record previous/new result; clear grading observation; open incident. Regrade authoritative losses. Review previously eliminated entries, later eligibility and generated notices before explicit restoration/correction. Do not silently resurrect players or resend old notices. |
| Championship | After assignments, authoritative finals and grading, mark completed and clear active day. |

Stable game UUID and ESPN event ID retain game identity. New feed syncs store ESPN team IDs and accepted picks capture game/team identity; historical abbreviation-only records are retained as unknown identity. Historical aliases may require explicit mapping before tournament admission. The current pool's season/start boundary is enforced, and previous losing selections remain disqualifying unless explicitly excused by restoration.

No new multiple-entry account model is introduced. Players remain the existing current-contest entries; fresh-contest rollover archives historical records. Concurrent pools with separate independent entries remain outside this repository's current account model.
