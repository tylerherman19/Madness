// Plain-English text for incidents. Pure: no database, no clock. Every key that can be recorded
// (record_incident / serverError) maps to a title, what it means for participants, what to do and,
// where one exists, a fix link. Unknown keys get a generic fallback.

export interface Workload { id: string; name: string; label: string }
// name: how a sentence names the job ("Updating scores was delayed"); label: the row name on the status page.
export const WORKLOADS: Workload[] = [
  { id: 'results', name: 'Updating scores', label: 'Update scores' },
  { id: 'grading', name: 'Grading picks', label: 'Grade picks' },
  { id: 'assignment', name: 'Assigning missed picks', label: 'Assign missed picks' },
  { id: 'advance', name: 'Moving to the next day', label: 'Move to the next day' },
  { id: 'schedule', name: 'Refreshing the schedule', label: 'Refresh the schedule' },
  { id: 'reminders', name: 'Reminders', label: 'Reminders' },
  { id: 'integrity', name: 'The data check', label: 'Data check' },
  { id: 'retention', name: 'Clean-up', label: 'Clean-up' },
  { id: 'campaigns', name: 'Email campaigns', label: 'Email campaigns' },
  { id: 'delivery', name: 'Sending email', label: 'Sending email' },
]
const byId = new Map(WORKLOADS.map((w) => [w.id, w]))
export const workloadName = (id: string) => byId.get(id)?.name ?? 'A background job'

// Older single-purpose cron routes report under their own key. They are the same work as a workload.
const ROUTE_WORKLOAD: Record<string, string> = {
  'api/cron/sync-results': 'results',
  'api/cron/auto-advance': 'advance',
  'api/cron/auto-assign': 'assignment',
  'api/cron/reminders': 'reminders',
}

// The workload an incident key belongs to, or null when it is not a job incident.
export function workloadOfKey(key: string): string | null {
  const m = /^api\/cron\/worker\/([a-z]+)$/.exec(key)
  if (m && byId.has(m[1])) return m[1]
  return ROUTE_WORKLOAD[key] ?? null
}

// Incident keys a successful run of a workload clears. Only "delayed" / "server error" job keys:
// never turnover-missed, result-review, wrongly-eliminated, schedule or assignment-* review keys.
export function recoveryKeysForWorkload(workload: string): string[] {
  const keys = [`api/cron/worker/${workload}`]
  for (const [route, id] of Object.entries(ROUTE_WORKLOAD)) if (id === workload) keys.push(route)
  return keys
}

// Incidents that need a person to look, whatever happens to the jobs.
export const HUMAN_DECISION_PREFIXES = [
  'turnover-missed:', 'result-review:', 'team-identity:', 'schedule-sync:', 'schedule-change:',
  'result-correction:', 'wrongly-eliminated:', 'assignment-rankings:', 'assignment-name-order:',
]
export const needsHuman = (key: string) => HUMAN_DECISION_PREFIXES.some((p) => key.startsWith(p))

export interface IncidentInput { key: string; occurrences: number; first_at?: string; latest_at: string }
export interface JobStatus { id: string; lastSuccessAt: string | null }
export interface IncidentCard {
  key: string
  title: string
  meaning: string
  todo: string
  fix?: { href: string; label: string }
  occurrences: number
  latestAt: string
  recovered: boolean
  jobName?: string
}

const TEXTS: { prefix: string; title: string; meaning: string; todo: string; fix?: { href: string; label: string } }[] = [
  { prefix: 'turnover-missed:', title: 'The site is behind on days',
    meaning: 'A day opened after its pick deadline had already passed, so the site is not showing today\'s games for picks.',
    todo: 'Use "Jump to the current day". The days that were missed are skipped: nobody gets a pick assigned or is eliminated for them.',
    fix: { href: '/admin/system', label: 'Go to the jump button' } },
  { prefix: 'result-review:', title: 'A game result needs a decision',
    meaning: 'The scores feed gave an unusual or conflicting result, so grading is holding that game. Entries that picked it are not graded yet.',
    todo: 'Open Results, look at the game and confirm or enter the result.', fix: { href: '/admin/results', label: 'Open Results' } },
  { prefix: 'team-identity:', title: 'A team name looks wrong in the schedule',
    meaning: 'Two teams share an abbreviation or a team changed identity, so the schedule for that day is being held back.',
    todo: 'Open Schedule and check that day\'s games.', fix: { href: '/admin/schedule', label: 'Open Schedule' } },
  { prefix: 'schedule-sync:', title: 'The schedule changed after picks were made',
    meaning: 'A game that people already picked was moved or changed in the feed. The change was NOT applied, so picks stay safe.',
    todo: 'Open Schedule and check the game. If the change is real, fix it by hand.', fix: { href: '/admin/schedule', label: 'Open Schedule' } },
  { prefix: 'schedule-change:', title: 'A picked game was changed in the schedule',
    meaning: 'A game people picked was changed. The system kept the original so nobody\'s pick was altered.',
    todo: 'Open Schedule and check the game and the entries that picked it.', fix: { href: '/admin/schedule', label: 'Open Schedule' } },
  { prefix: 'result-correction:', title: 'A final score was corrected',
    meaning: 'A result changed after it was final, which can change who should be alive.',
    todo: 'Open Results and check that the right entries are alive. Restore anyone who was eliminated by mistake.', fix: { href: '/admin/results', label: 'Open Results' } },
  { prefix: 'wrongly-eliminated:', title: 'An entry may have been eliminated by mistake',
    meaning: 'A corrected result means an entry no longer lost, but a later day has already locked so the system did not restore it.',
    todo: 'Open Players and restore the entry if the correction is right.', fix: { href: '/admin/players', label: 'Open Players' } },
  { prefix: 'assignment-rankings:', title: 'Missed picks are waiting on rankings',
    meaning: 'Some entries missed the deadline and the system has no AP rankings to choose their team fairly, so it is waiting.',
    todo: 'Usually fixes itself when rankings load. Otherwise enter those picks by hand.', fix: { href: '/admin/players', label: 'Open Players' } },
  { prefix: 'assignment-name-order:', title: 'A missed pick was chosen by team name',
    meaning: 'Two teams tied on seed and rankings could not separate them, so the pick was chosen by name. This is informational.',
    todo: 'Nothing is required. Mark it resolved once you have read it.' },
]

export function describeIncident(i: IncidentInput, jobs: JobStatus[] = []): IncidentCard {
  const base = { key: i.key, occurrences: i.occurrences, latestAt: i.latest_at }
  const text = TEXTS.find((t) => i.key.startsWith(t.prefix))
  if (text) return { ...base, title: text.title, meaning: text.meaning, todo: text.todo, fix: text.fix, recovered: false }
  const workload = workloadOfKey(i.key)
  if (workload) {
    const name = workloadName(workload)
    const job = jobs.find((j) => j.id === workload)
    const recovered = Boolean(job?.lastSuccessAt && new Date(job.lastSuccessAt) > new Date(i.latest_at))
    const kind = i.key.startsWith('api/cron/worker') ? 'was delayed' : 'hit an error'
    return {
      ...base, jobName: name, recovered,
      title: `${name} ${kind}`,
      meaning: 'Saved picks are not affected. The job tries again by itself every minute.',
      todo: recovered ? 'Nothing to do. It has been running normally since.' : 'Wait a few minutes. If it keeps happening, open Advanced details > Background jobs.',
      fix: recovered ? undefined : { href: '/admin/system/jobs', label: 'See background jobs' },
    }
  }
  return {
    ...base, recovered: false, title: 'Something went wrong',
    meaning: 'A part of the site reported a problem. Picks that were saved are safe.',
    todo: 'If it keeps happening, check Advanced details > Errors and incidents, or mark it resolved once it is dealt with.',
    fix: { href: '/admin/system/incidents', label: 'See technical details' },
  }
}

// One sentence for a job incident: "Updating scores was delayed 42 times, last on Nov 10. It has been running normally since."
export function incidentSentence(card: IncidentCard, lastOn: string): string {
  if (!card.jobName) return ''
  const verb = card.title.slice(card.jobName.length + 1)
  const times = card.occurrences === 1 ? 'once' : `${card.occurrences} times`
  return `${card.jobName} ${verb} ${times}, last on ${lastOn}.${card.recovered ? ' It has been running normally since.' : ''}`
}

export interface StatusSummary { open: IncidentCard[]; recovered: IncidentCard[]; failingJobs: number; lateJobs: number; staleDay: boolean; needs: number; headline: string }

// What N counts, once: incidents still needing attention, jobs that are failing or late, and a stale
// day. Recovered job incidents are never counted, and a job incident is not counted a second time
// when its job row is already failing or late.
export function summarize(incidents: IncidentInput[], jobs: JobStatus[], jobStates: { id: string; state: 'ok' | 'overdue' | 'failing' | 'off' }[], isStale: boolean, extraNeeds = 0): StatusSummary {
  const cards = incidents.map((i) => describeIncident(i, jobs))
  const open = cards.filter((c) => !c.recovered)
  const recovered = cards.filter((c) => c.recovered)
  const bad = new Set(jobStates.filter((s) => s.state === 'failing' || s.state === 'overdue').map((s) => s.id))
  const failingJobs = jobStates.filter((s) => s.state === 'failing').length
  const lateJobs = jobStates.filter((s) => s.state === 'overdue').length
  const counted = open.filter((c) => { const w = workloadOfKey(c.key); return !(w && bad.has(w)) })
  // A stale day is already explained by its own incident when present; do not count it twice.
  const staleIncident = open.some((c) => c.key.startsWith('turnover-missed:'))
  const needs = counted.length + failingJobs + lateJobs + extraNeeds + (isStale && !staleIncident ? 1 : 0)
  return { open, recovered, failingJobs, lateJobs, staleDay: isStale, needs, headline: needs === 0 ? 'Everything is running' : needs === 1 ? '1 thing needs your attention' : `${needs} things need your attention` }
}
