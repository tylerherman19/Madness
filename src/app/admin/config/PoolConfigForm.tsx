'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  COMPETITION_COPY,
  MODE_LABEL,
  POOL_STATUSES,
  STATUS_LABEL,
  type CompetitionMode,
  type PoolConfig,
  type PoolStatus,
} from '@/lib/competition'

// Explanatory text under the segmented control. Concise on purpose: an
// administrator choosing a format needs to know what turns on, not a manual.
const MODE_BLURB: Record<CompetitionMode, string> = {
  'regular-season': COMPETITION_COPY['regular-season'].blurb,
  'march-madness': COMPETITION_COPY['march-madness'].blurb,
}

const PICK_FREQUENCY_OPTIONS: [string, string, string][] = [
  ['every-game-day', 'Every game day', 'One pick per day that has games.'],
  ['weekends-only', 'Weekends only', 'Picks are required on Saturdays and Sundays.'],
  ['tournament-round', 'Per tournament round', "The round's quota, spent across that round's days."],
]

const DEADLINE_OPTIONS: [string, string, string][] = [
  ['first-tip', "First tip of the day", 'The whole slate locks together, at its earliest tip.'],
  ['per-game', 'Each game individually', "Every pick locks at its own team's tip."],
]

const REUSE_OPTIONS: [string, string, string][] = [
  ['once-per-pool', 'Once per pool', 'Classic survivor — a team is spent for good.'],
  ['once-per-round', 'Once per round', 'Teams reset when a new round starts.'],
  ['unlimited', 'No restriction', 'Any eligible team, any pick period.'],
]

const AUTO_PICK_OPTIONS: [string, string, string][] = [
  ['latest-game', 'Assign from the last game', "Missed the lock? The day's latest unused team is assigned."],
  ['eliminate', 'Eliminate', 'Missing the lock ends the entry immediately.'],
  ['none', 'Leave blank', 'No pick is recorded and nothing is graded.'],
]

const TIEBREAKER_OPTIONS: [string, string, string][] = [
  ['seed-total', 'Highest seed total', 'Sum of the seeds taken — rewards riskier picks. Tournament only.'],
  ['most-survived', 'Most pick periods survived', 'The entry that lasted the longest.'],
  ['none', 'Split the pot', 'Co-champions share it.'],
]

function Segmented({
  value,
  onChange,
  disabled,
}: {
  value: CompetitionMode
  onChange: (mode: CompetitionMode) => void
  disabled?: boolean
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Competition Format"
      className="inline-flex rounded-lg p-1 w-full sm:w-auto"
      style={{ background: '#0f172a', border: '1px solid #334155' }}
    >
      {(['regular-season', 'march-madness'] as CompetitionMode[]).map((mode) => {
        const on = value === mode
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(mode)}
            className="flex-1 sm:flex-none px-5 py-2 text-sm font-semibold rounded-md transition-colors whitespace-nowrap"
            style={{
              background: on ? 'var(--red)' : 'transparent',
              color: on ? '#fff' : '#94a3b8',
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            {MODE_LABEL[mode]}
          </button>
        )
      })}
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium uppercase tracking-wide text-slate-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  )
}

const SELECT_CLASS =
  'mt-1.5 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-white'

function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: [string, string, string][]
  onChange: (v: string) => void
}) {
  const hint = options.find(([v]) => v === value)?.[2]
  return (
    <Field label={label} hint={hint}>
      <select className={SELECT_CLASS} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </Field>
  )
}

// What a mode switch actually does, spelled out before it happens. Nothing is
// deleted — the confirmation says so explicitly, because that is the fear.
function ModeSwitchDialog({
  from,
  to,
  onCancel,
  onConfirm,
  busy,
}: {
  from: CompetitionMode
  to: CompetitionMode
  onCancel: () => void
  onConfirm: () => void
  busy: boolean
}) {
  const toTournament = to === 'march-madness'
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(2,6,23,0.75)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="mode-switch-title"
    >
      <div className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-800 p-6">
        <p id="mode-switch-title" className="text-lg font-bold text-white">
          Switch to {MODE_LABEL[to]} Mode?
        </p>
        <p className="mt-3 text-sm leading-relaxed text-slate-300">
          {toTournament
            ? 'Tournament-specific round names, seeds, bracket information, and scheduling will become active.'
            : 'Tournament rounds, seeds, regions, and bracket context will be hidden. The pool returns to game-day organisation and regular-season terminology.'}
        </p>
        <p className="mt-3 text-sm leading-relaxed text-slate-300">
          Existing users, picks, and pool history will <strong className="text-white">NOT</strong> be
          deleted. This changes how the same survivor history is organised and displayed.
        </p>
        <p className="mt-3 text-xs text-slate-500">
          Currently {MODE_LABEL[from]}. You can switch back at any time.
        </p>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            style={{ background: 'var(--red)' }}
          >
            {busy ? 'Switching…' : 'Switch Mode'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function PoolConfigForm({ pool }: { pool: PoolConfig }) {
  const router = useRouter()
  const [draft, setDraft] = useState<PoolConfig>(pool)
  const [pendingMode, setPendingMode] = useState<CompetitionMode | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  const set = <K extends keyof PoolConfig>(key: K, value: PoolConfig[K]) => {
    setDraft((d) => ({ ...d, [key]: value }))
    setSaved('')
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(pool)

  async function save(patch: Partial<PoolConfig>, note: string) {
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/admin/pool-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pool_id: pool.id, ...patch }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Failed to save')
        return false
      }
      setDraft(data.pool)
      setSaved(note)
      router.refresh()
      return true
    } catch {
      setError('Something went wrong. Try again.')
      return false
    } finally {
      setSaving(false)
    }
  }

  // Everything except competition_mode saves directly. The mode goes through
  // the confirmation first — it is the one setting that visibly rewrites the
  // whole product for every player.
  async function saveSettings() {
    await save(
      {
        name: draft.name,
        status: draft.status,
        season_year: draft.season_year,
        pick_frequency: draft.pick_frequency,
        pick_deadline_rule: draft.pick_deadline_rule,
        team_reuse_rule: draft.team_reuse_rule,
        auto_pick_behavior: draft.auto_pick_behavior,
        tiebreaker: draft.tiebreaker,
        starts_on: draft.starts_on,
      },
      'Pool configuration saved.'
    )
  }

  async function confirmModeSwitch() {
    if (!pendingMode) return
    const ok = await save({ competition_mode: pendingMode }, `Now running in ${MODE_LABEL[pendingMode]} mode.`)
    if (ok) setPendingMode(null)
  }

  const mode = draft.competition_mode

  return (
    <div className="space-y-8">
      {/* ---- Competition Format ---- */}
      <section className="rounded-xl border border-slate-700 bg-slate-800 p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Competition Format</p>
        <p className="mt-1 text-sm text-slate-400">
          The administrator decides the format. It is never inferred from the calendar.
        </p>

        <div className="mt-4">
          <Segmented
            value={mode}
            disabled={saving}
            onChange={(next) => {
              if (next === mode) return
              setPendingMode(next)
            }}
          />
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {(['regular-season', 'march-madness'] as CompetitionMode[]).map((m) => (
            <div
              key={m}
              className="rounded-lg border p-3"
              style={{
                borderColor: m === mode ? 'var(--red)' : '#334155',
                background: m === mode ? 'rgba(180,30,30,0.08)' : 'transparent',
              }}
            >
              <p className="text-sm font-semibold text-white">{MODE_LABEL[m]}</p>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">{MODE_BLURB[m]}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---- Pool settings ---- */}
      <section className="rounded-xl border border-slate-700 bg-slate-800 p-5 space-y-5">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Pool Settings</p>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Pool Name">
            <input
              className={SELECT_CLASS}
              value={draft.name}
              maxLength={80}
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>

          <Field label="Season" hint="The NCAA season this pool is played in.">
            <input
              className={SELECT_CLASS}
              type="number"
              value={draft.season_year}
              min={2000}
              max={2100}
              onChange={(e) => set('season_year', Number(e.target.value))}
            />
          </Field>

          <Choice
            label="Pick Frequency"
            value={draft.pick_frequency}
            options={PICK_FREQUENCY_OPTIONS}
            onChange={(v) => set('pick_frequency', v as PoolConfig['pick_frequency'])}
          />

          <Choice
            label="Pick Deadline Rule"
            value={draft.pick_deadline_rule}
            options={DEADLINE_OPTIONS}
            onChange={(v) => set('pick_deadline_rule', v as PoolConfig['pick_deadline_rule'])}
          />

          <Choice
            label="Team Reuse Rule"
            value={draft.team_reuse_rule}
            options={REUSE_OPTIONS}
            onChange={(v) => set('team_reuse_rule', v as PoolConfig['team_reuse_rule'])}
          />

          <Choice
            label="Auto-Pick Behavior"
            value={draft.auto_pick_behavior}
            options={AUTO_PICK_OPTIONS}
            onChange={(v) => set('auto_pick_behavior', v as PoolConfig['auto_pick_behavior'])}
          />

          <Choice
            label="Tiebreaker"
            value={draft.tiebreaker}
            options={TIEBREAKER_OPTIONS}
            onChange={(v) => set('tiebreaker', v as PoolConfig['tiebreaker'])}
          />

          <Field label="Pool Start Date" hint="Optional. The day the pool opens for play.">
            <input
              className={SELECT_CLASS}
              type="date"
              value={draft.starts_on ?? ''}
              onChange={(e) => set('starts_on', e.target.value || null)}
            />
          </Field>

          <Field
            label="Pool Status"
            hint="Where the pool is in its lifecycle — separate from the competition format."
          >
            <select
              className={SELECT_CLASS}
              value={draft.status}
              onChange={(e) => set('status', e.target.value as PoolStatus)}
            >
              {POOL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {error && (
          <p className="rounded-lg px-3 py-2 text-sm" style={{ background: 'rgba(180,30,30,0.15)', color: '#fca5a5' }}>
            {error}
          </p>
        )}
        {saved && !error && <p className="text-sm text-green-400">{saved}</p>}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={saveSettings}
            disabled={saving || !dirty}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: 'var(--red)' }}
          >
            {saving ? 'Saving…' : 'Save Configuration'}
          </button>
          {dirty && <span className="text-xs text-slate-500">Unsaved changes</span>}
        </div>
      </section>

      {pendingMode && (
        <ModeSwitchDialog
          from={mode}
          to={pendingMode}
          busy={saving}
          onCancel={() => setPendingMode(null)}
          onConfirm={confirmModeSwitch}
        />
      )}
    </div>
  )
}
