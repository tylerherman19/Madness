// Pure health evaluation for the admin Operations page: rows in, one status per
// line out. No database or clock access here; the caller passes `now`.

export type HealthStatus = 'ok' | 'overdue' | 'failing' | 'off'

export interface JobRun {
  key: string
  status: string
  last_success_at: string | null
  updated_at?: string | null
  last_error?: string | null
}
export interface IncidentRow {
  key: string
  impact?: string | null
  status: string
  occurrences: number
  latest_at: string
}
export interface HealthLine {
  id: string
  label: string
  status: HealthStatus
  detail: string
  lastSuccessAt: string | null
  lastError: string | null
}

// Overdue = no successful run within this many minutes. The scheduler calls the
// worker every 5 minutes (.github/workflows/operations.yml), so a 15-minute
// limit is three missed ticks; slower workloads get a longer allowance.
export const JOB_SPECS: { id: string; key: string; label: string; maxMinutes: number }[] = [
  { id: 'schedule', key: 'recurring:schedule', label: 'Schedule sync', maxMinutes: 60 },
  { id: 'results', key: 'recurring:results', label: 'Results sync', maxMinutes: 15 },
  { id: 'assignment', key: 'recurring:assignment', label: 'Auto-assignment', maxMinutes: 15 },
  { id: 'grading', key: 'recurring:grading', label: 'Grading', maxMinutes: 15 },
  { id: 'advance', key: 'recurring:advance', label: 'Slate advancement', maxMinutes: 30 },
]
export const HEARTBEAT_MAX_MINUTES = 10
// After lock, auto-assignment gets this long before a missing run is called overdue.
export const ASSIGNMENT_GRACE_MINUTES = 10

export interface SlateState {
  slate_date: string
  // Effective deadline for the active day (first tip / locks_at), ISO.
  deadline: string | null
  auto_assign_completed_at: string | null
}
export interface HealthInput {
  now: Date
  // False when AUTOMATION_V2_ENABLED is off: no scheduled work is expected.
  automationEnabled: boolean
  // True when TOURNAMENT_RELIABILITY_ENABLED: per-workload recurring:* rows exist.
  perWorkload: boolean
  jobs: JobRun[]
  incidents: IncidentRow[]
  slate: SlateState | null
  // Alive entries missing required picks for the active day; null when unknown.
  unpicked: number | null
  attentionCount: number
  contest: { stopped: boolean; alive: number } | null
  databaseOk: boolean
  sessionSecret?: string | null
}
export interface IncidentGroup { key: string; impact: string; occurrences: number; latestAt: string }
export interface Health {
  lines: HealthLine[]
  incidents: IncidentGroup[]
  assignment: { state: 'no-slate' | 'unlocked' | 'complete' | 'incomplete'; unpicked: number | null }
  stopped: boolean
  weakSecret: boolean
  overall: HealthStatus
}

const minutesSince = (iso: string, now: Date) => (now.getTime() - new Date(iso).getTime()) / 60_000

export function evaluateJob(
  id: string, label: string, run: JobRun | undefined, maxMinutes: number, now: Date, automationEnabled: boolean,
): HealthLine {
  const lastSuccessAt = run?.last_success_at ?? null
  const lastError = run?.last_error ?? null
  const base = { id, label, lastSuccessAt, lastError }
  if (!automationEnabled) return { ...base, status: 'off', detail: 'Automation is switched off; nothing is scheduled.' }
  if (run && (run.status === 'review' || run.status === 'failed' || lastError)) {
    return { ...base, status: 'failing', detail: run.status === 'review' ? 'Needs review after repeated failures.' : 'Last attempt failed.' }
  }
  if (!lastSuccessAt) return { ...base, status: 'overdue', detail: 'No successful run recorded.' }
  const age = minutesSince(lastSuccessAt, now)
  if (age > maxMinutes) return { ...base, status: 'overdue', detail: `No successful run in ${Math.floor(age)} min (expected within ${maxMinutes}).` }
  return { ...base, status: 'ok', detail: 'Running on schedule.' }
}

export function assignmentState(input: Pick<HealthInput, 'slate' | 'unpicked' | 'now'>): Health['assignment'] & { minutesAfterLock: number } {
  const { slate, unpicked, now } = input
  if (!slate) return { state: 'no-slate', unpicked, minutesAfterLock: 0 }
  const deadline = slate.deadline ? new Date(slate.deadline) : null
  if (!deadline || deadline.getTime() > now.getTime()) return { state: 'unlocked', unpicked, minutesAfterLock: 0 }
  const minutesAfterLock = (now.getTime() - deadline.getTime()) / 60_000
  const incomplete = !slate.auto_assign_completed_at && (unpicked ?? 1) > 0
  return { state: incomplete ? 'incomplete' : 'complete', unpicked, minutesAfterLock }
}

export function evaluateHealth(input: HealthInput): Health {
  const { now, jobs } = input
  const byKey = new Map(jobs.map((j) => [j.key, j]))
  const lines: HealthLine[] = []

  lines.push({
    id: 'database', label: 'Database connection', lastSuccessAt: null, lastError: null,
    status: input.databaseOk ? 'ok' : 'failing',
    detail: input.databaseOk ? 'Operations records read successfully.' : 'Could not read operations records.',
  })

  if (input.perWorkload) {
    for (const spec of JOB_SPECS) lines.push(evaluateJob(spec.id, spec.label, byKey.get(spec.key), spec.maxMinutes, now, input.automationEnabled))
  }
  // Heartbeat: the newest successful pass of any scheduled work.
  const heartbeatRows = jobs.filter((j) => (input.perWorkload ? j.key.startsWith('recurring:') : j.key.startsWith('worker:')) && j.last_success_at)
  const newest = heartbeatRows.reduce<JobRun | undefined>((a, b) => (!a || new Date(b.last_success_at!) > new Date(a.last_success_at!) ? b : a), undefined)
  lines.push(evaluateJob('heartbeat', 'Worker heartbeat', newest, HEARTBEAT_MAX_MINUTES, now, input.automationEnabled))

  const assignment = assignmentState(input)
  const unpickedText = assignment.unpicked == null ? 'unknown number of' : String(assignment.unpicked)
  lines.push({
    id: 'assignment-day', label: 'Auto-assignment for the active day', lastSuccessAt: input.slate?.auto_assign_completed_at ?? null, lastError: null,
    ...(assignment.state === 'no-slate' ? { status: 'ok' as const, detail: 'No active day.' }
      : assignment.state === 'unlocked' ? { status: 'ok' as const, detail: 'Day has not locked yet.' }
      : assignment.state === 'complete' ? { status: 'ok' as const, detail: 'Complete. Every alive entry has its required picks.' }
      : assignment.minutesAfterLock <= ASSIGNMENT_GRACE_MINUTES
        ? { status: 'ok' as const, detail: `Locked ${Math.floor(assignment.minutesAfterLock)} min ago; ${unpickedText} alive entries still need picks. Assignment should run shortly.` }
        : { status: 'overdue' as const, detail: `Locked ${Math.floor(assignment.minutesAfterLock)} min ago and auto-assignment has not completed; ${unpickedText} alive entries lack required picks.` }),
  })

  const stopped = input.contest?.stopped === true
  lines.push({
    id: 'contest', label: 'Contest progress', lastSuccessAt: null, lastError: null,
    status: input.attentionCount > 0 ? 'failing' : 'ok',
    detail: [
      stopped ? 'Stopped: no entries alive.' : null,
      input.attentionCount > 0 ? `${input.attentionCount} result${input.attentionCount === 1 ? '' : 's'} need attention (stalled games or entries awaiting manual restore).` : 'No stalled games or entries awaiting restore.',
    ].filter(Boolean).join(' '),
  })

  const open = input.incidents.filter((i) => i.status === 'open')
  const groups = open
    .map((i) => ({ key: i.key, impact: i.impact ?? i.key, occurrences: i.occurrences, latestAt: i.latest_at }))
    .sort((a, b) => b.latestAt.localeCompare(a.latestAt))

  const weakSecret = input.sessionSecret === 'weak'
  const rank: Record<HealthStatus, number> = { off: 0, ok: 0, overdue: 1, failing: 2 }
  const worst = lines.reduce<HealthStatus>((w, l) => (rank[l.status] > rank[w] ? l.status : w), 'ok')
  return { lines, incidents: groups, assignment: { state: assignment.state, unpicked: assignment.unpicked }, stopped, weakSecret, overall: worst }
}
