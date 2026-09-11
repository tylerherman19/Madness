import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getAdminSession } from '@/lib/session'
import { getPoolConfig } from '@/lib/pool'
import { capabilitiesFor, copyFor, MODE_LABEL, STATUS_LABEL } from '@/lib/competition'
import PoolConfigForm from './PoolConfigForm'

export const metadata = { title: 'Pool Configuration — MADNESS Admin' }

export default async function PoolConfigPage() {
  const isAdmin = await getAdminSession()
  if (!isAdmin) redirect('/admin/login')

  const pool = await getPoolConfig()
  const caps = capabilitiesFor(pool.competition_mode)
  const copy = copyFor(pool.competition_mode)

  // No id means there is no pools row behind this screen — the migration
  // hasn't been applied. Say so plainly instead of rendering a form whose
  // every save would fail.
  const unconfigured = !pool.id

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: 'var(--dark)' }}>
          Pool Configuration
        </h1>
        <p className="mt-1" style={{ color: 'var(--muted)' }}>
          {pool.name} · {MODE_LABEL[pool.competition_mode]} · {STATUS_LABEL[pool.status]} · Season{' '}
          {pool.season_year}
        </p>
      </div>

      {unconfigured ? (
        <div className="rounded-xl border border-amber-500/40 bg-slate-800 p-4">
          <p className="font-medium text-amber-400">No pool row found.</p>
          <p className="mt-1 text-sm text-slate-400">
            Apply <code>supabase/migrations/017_pool_configuration.sql</code> against the project,
            then reload this page. Until then the app runs on the Regular Season defaults shown
            below.
          </p>
        </div>
      ) : (
        <PoolConfigForm pool={pool} />
      )}

      {/* What the current format turns on. Reading the capability table back
          to the administrator is the fastest way to answer "what does this
          setting actually do". */}
      <section className="rounded-xl border border-slate-700 bg-slate-800 p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
          Active in {MODE_LABEL[pool.competition_mode]}
        </p>
        <p className="mt-2 text-sm text-slate-400">{copy.blurb}</p>
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          <Capability on={caps.showSeeds} label="Tournament seeds" />
          <Capability on={caps.showRegions} label="Regions" />
          <Capability on={caps.showTournamentRounds} label="Tournament rounds" />
          <Capability on={caps.groupScheduleByRound} label="Schedule grouped by round" />
          <Capability on={caps.showTournamentHeader} label="Round header with survivor counts" />
          <Capability on={caps.labelPicksByRound} label="Pick history labelled by round" />
          <Capability on={caps.showPollRank} label="AP Top 25 context" />
          <Capability on={caps.showSeedTotal} label="Seed-total tiebreak" />
        </ul>
        <p className="mt-4 text-xs text-slate-500">
          Supporting line under the wordmark:{' '}
          <span className="text-slate-300">MADNESS · {copy.tagline}</span>
        </p>
      </section>

      <div className="flex flex-wrap gap-4 text-sm">
        <Link href="/admin" className="text-blue-400 underline">
          ← Admin dashboard
        </Link>
        <Link href="/admin/schedule" className="text-blue-400 underline">
          Schedule
        </Link>
      </div>
    </div>
  )
}

function Capability({ on, label }: { on: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: on ? 'var(--green)' : '#475569' }}
      />
      <span style={{ color: on ? '#e2e8f0' : '#64748b' }}>{label}</span>
      <span className="sr-only">{on ? 'enabled' : 'disabled'}</span>
    </li>
  )
}
