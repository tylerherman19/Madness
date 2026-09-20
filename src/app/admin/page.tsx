import { redirect } from 'next/navigation'
import { getAdminSession } from '@/lib/session'
import { getDb, getEffectiveNow } from '@/lib/testMode'
import { getSignupCutoff } from '@/lib/season'
import { getPoolConfig } from '@/lib/pool'
import { MODE_LABEL, STATUS_LABEL } from '@/lib/competition'
import { formatCentralTime } from '@/lib/deadline'
import { seedTotalsByPlayer } from '@/lib/standings'
import Link from 'next/link'
import AdvanceWeekButton from './AdvanceWeekButton'
import SetActiveWeek from './SetActiveWeek'
import ResetPoolButton from './ResetPoolButton'

export default async function AdminDashboard() {
  const isAdmin = await getAdminSession()
  if (!isAdmin) redirect('/admin/login')
  const supabase = await getDb()

  const [
    { data: slate },
    { data: players },
    { data: allWeeks },
    { data: allPicks },
    signupAnchor,
    now,
    pool,
  ] = await Promise.all([
    supabase.from('slates').select('*').eq('is_active', true).single(),
    supabase.from('players').select('id, full_name, email, status, paid'),
    supabase.from('slates').select('id, slate_number, slate_date, season_year, is_active').order('slate_date'),
    supabase.from('picks').select('player_id, seed'),
    getSignupCutoff(),
    getEffectiveNow(),
    getPoolConfig(supabase),
  ])

  // Surfaced so the signup gate is inspectable rather than inferred — this is
  // the exact value haveSignupsClosed() compares against.
  const signupsClosed = signupAnchor ? now >= signupAnchor.cutoff : false

  const alive = players?.filter((p: { status: string }) => p.status === 'alive') || []
  const paid = players?.filter((p: { paid: boolean }) => p.paid) || []

  // Internal test accounts shouldn't clutter chase lists
  const realPlayers = (players || []).filter(
    (p: { email: string }) => !p.email?.endsWith('@nflsurvivor.internal')
  )
  const unpaidPlayers = realPlayers.filter((p: { paid: boolean }) => !p.paid)

  // Seed totals are a running tournament score, not a snapshot of the active
  // slate. Include every real player so the admin can also see who is still at
  // zero before their first seeded pick.
  const seedTotals = seedTotalsByPlayer(allPicks || [])
  const seededPickCounts: Record<string, number> = {}
  for (const pick of allPicks || []) {
    if (pick.seed != null) {
      seededPickCounts[pick.player_id] = (seededPickCounts[pick.player_id] || 0) + 1
    }
  }
  const seedLeaderboard = realPlayers
    .map((player: { id: string; full_name: string; status: string }) => ({
      ...player,
      seedTotal: seedTotals[player.id] || 0,
      seededPicks: seededPickCounts[player.id] || 0,
    }))
    .sort(
      (a: { seedTotal: number; full_name: string }, b: { seedTotal: number; full_name: string }) =>
        b.seedTotal - a.seedTotal ||
        a.full_name.localeCompare(b.full_name, undefined, { sensitivity: 'base' })
    )

  let pickCount = 0
  let pickDistribution: { team: string; count: number; pct: number }[] = []
  let notPickedYet: string[] = []
  let games: { id: string; home_team: string; away_team: string; result: string; game_day: string }[] = []

  if (slate) {
    const [{ data: picks }, { data: gamesData }] = await Promise.all([
      supabase.from('picks').select('player_id, team').eq('slate_id', slate.id),
      supabase.from('games').select('id, home_team, away_team, result, game_day').eq('slate_id', slate.id).order('tip_time'),
    ])
    games = gamesData || []
    const picksData = picks || []
    pickCount = picksData.length

    const countByTeam: Record<string, number> = {}
    for (const p of picksData) {
      countByTeam[p.team] = (countByTeam[p.team] || 0) + 1
    }
    pickDistribution = Object.entries(countByTeam)
      .map(([team, count]) => ({ team, count, pct: pickCount > 0 ? (count / pickCount) * 100 : 0 }))
      .sort((a, b) => b.count - a.count)

    const pickedIds = new Set(picksData.map((p: { player_id: string }) => p.player_id))
    notPickedYet = realPlayers
      .filter((p: { id: string; status: string }) => p.status === 'alive' && !pickedIds.has(p.id))
      .map((p: { full_name: string }) => p.full_name)
      .sort()
  }

  const gradedCount = games.filter((g) => g.result !== 'pending').length

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: 'var(--dark)' }}>Admin Dashboard</h1>
        {slate && (
          <p className="mt-1" style={{ color: 'var(--muted)' }}>
            Active: Slate {slate.slate_number} · Season {slate.season_year}
          </p>
        )}
      </div>

      {/* Competition format, up front. Everything a player sees — the
          terminology, the seeds, the schedule grouping — follows from it, so
          the dashboard should never leave an admin guessing which mode the
          pool is in. Format and status are separate facts and are shown as
          such. */}
      <div className="rounded-xl border border-slate-700 bg-slate-800 p-4 flex flex-wrap items-center gap-x-6 gap-y-2">
        <div>
          <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">Competition Format</p>
          <p className="mt-0.5 font-semibold text-white">{MODE_LABEL[pool.competition_mode]}</p>
        </div>
        <div>
          <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">Pool Status</p>
          <p className="mt-0.5 font-semibold text-white">{STATUS_LABEL[pool.status]}</p>
        </div>
        <div>
          <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">Pool</p>
          <p className="mt-0.5 font-semibold text-white">{pool.name} · {pool.season_year}</p>
        </div>
        <Link
          href="/admin/config"
          className="ml-auto rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-700"
        >
          Pool Configuration →
        </Link>
      </div>

      <div className="rounded-xl border border-slate-700 bg-slate-800 p-4">
        <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-2">Signups</p>
        {!signupAnchor ? (
          <>
            <p className="text-green-400 font-medium">Open — no cutoff yet</p>
            <p className="text-slate-400 text-sm mt-1">
              Nothing to anchor to until an active slate exists with games synced. Signups stay open until then.
            </p>
          </>
        ) : (
          <>
            <p className={`font-medium ${signupsClosed ? 'text-red-400' : 'text-green-400'}`}>
              {signupsClosed ? 'Closed' : 'Open'} — {signupsClosed ? 'closed' : 'closes'} {formatCentralTime(signupAnchor.cutoff)}
            </p>
            <p className="text-slate-400 text-sm mt-1">
              Anchored to Slate {signupAnchor.slateNumber} · Season {signupAnchor.seasonYear}
              {' '}— that slate&apos;s Sunday 12:00 PM CT pick deadline. Advancing slates does not move it.
            </p>
          </>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Total Players" value={players?.length || 0} />
        <StatCard label="Paid" value={`${paid.length}/${players?.length || 0}`} />
        <StatCard label="Still Alive" value={alive.length} color="text-green-400" />
        <StatCard label="Picks This Slate" value={`${pickCount}/${alive.length}`} />
      </div>

      <section className="rounded-xl border border-slate-700 bg-slate-800 overflow-hidden">
        <div className="border-b border-slate-700 px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-white">Seed totals</h2>
              <p className="mt-1 text-sm text-slate-400">
                Running sum of every tournament seed picked. Highest total ranks first.
              </p>
            </div>
            {pool.competition_mode !== 'march-madness' && (
              <span className="text-xs text-slate-500">Starts with March Madness picks</span>
            )}
          </div>
        </div>

        {seedLeaderboard.length === 0 ? (
          <p className="px-4 py-5 text-sm text-slate-500 sm:px-5">No players have joined yet.</p>
        ) : (
          <>
            <div className="divide-y divide-slate-700 sm:hidden">
              {seedLeaderboard.map((player, index) => (
                <div key={player.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="w-6 shrink-0 text-center text-xs font-semibold text-slate-500">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-white">{player.full_name}</p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {player.seededPicks} seeded pick{player.seededPicks === 1 ? '' : 's'} ·{' '}
                      {player.status === 'alive' ? 'Alive' : 'Out'}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xl font-bold tabular-nums text-white">{player.seedTotal}</p>
                    <p className="text-[11px] text-slate-500">seed total</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-left text-xs text-slate-500">
                    <th className="w-14 px-5 py-2.5 font-medium">Rank</th>
                    <th className="px-4 py-2.5 font-medium">Player</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 text-right font-medium">Seeded picks</th>
                    <th className="px-5 py-2.5 text-right font-medium">Seed total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/70">
                  {seedLeaderboard.map((player, index) => (
                    <tr key={player.id}>
                      <td className="px-5 py-3 text-slate-500 tabular-nums">{index + 1}</td>
                      <td className="px-4 py-3 font-medium text-white">{player.full_name}</td>
                      <td className="px-4 py-3">
                        <span className={player.status === 'alive' ? 'text-green-400' : 'text-red-400'}>
                          {player.status === 'alive' ? 'Alive' : 'Out'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-slate-400 tabular-nums">
                        {player.seededPicks}
                      </td>
                      <td className="px-5 py-3 text-right text-base font-bold text-white tabular-nums">
                        {player.seedTotal}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {!slate && (
        <div className="rounded-xl border border-amber-500/40 bg-slate-800 p-4">
          <p className="text-amber-400 font-medium">No active slate set.</p>
          <p className="text-slate-400 text-sm mt-1">
            Go to <Link href="/admin/schedule" className="text-blue-400 underline">Schedule</Link> to load days from ESPN.
          </p>
        </div>
      )}
      {slate && (
        <AdvanceWeekButton currentSlateDate={slate.slate_date} />
      )}

      {slate && (
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Pick distribution */}
          <div className="rounded-xl border border-slate-700 bg-slate-800 p-4">
            <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-3">
              Slate {slate.slate_number} Pick Distribution
            </p>
            {pickDistribution.length === 0 ? (
              <p className="text-slate-500 text-sm">No picks yet.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {pickDistribution.map(({ team, count, pct }) => (
                    <tr key={team} className="border-b border-slate-700/60 last:border-0">
                      <td className="py-1.5">
                        <span className="font-mono font-bold text-white">{team}</span>
                      </td>
                      <td className="py-1.5 text-right text-white">{count}</td>
                      <td className="py-1.5 text-right text-slate-400 w-16">{pct.toFixed(0)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Missing picks */}
          <div className="rounded-xl border border-slate-700 bg-slate-800 p-4">
            <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-3">
              Haven&apos;t Picked Yet ({notPickedYet.length})
            </p>
            {notPickedYet.length === 0 ? (
              <p className="text-green-400 text-sm">Everyone alive has picked.</p>
            ) : (
              <>
                <p className="text-sm text-slate-300 leading-relaxed">{notPickedYet.join(', ')}</p>
                <Link href="/admin/email" className="inline-block mt-3 text-xs text-blue-400 underline">
                  Email these players
                </Link>
              </>
            )}
          </div>

          {/* Games / results status */}
          <div className="rounded-xl border border-slate-700 bg-slate-800 p-4">
            <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-3">
              Slate {slate.slate_number} Games ({gradedCount}/{games.length} graded)
            </p>
            {games.length === 0 ? (
              <p className="text-slate-500 text-sm">No games entered.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {games.map((g) => (
                  <li key={g.id} className="flex items-center justify-between">
                    <span className="font-mono text-white">
                      {g.away_team} @ {g.home_team}
                    </span>
                    <ResultBadge result={g.result} home={g.home_team} away={g.away_team} />
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Unpaid */}
          <div className="rounded-xl border border-slate-700 bg-slate-800 p-4">
            <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-3">
              Unpaid Players ({unpaidPlayers.length})
            </p>
            {unpaidPlayers.length === 0 ? (
              <p className="text-green-400 text-sm">Everyone has paid.</p>
            ) : (
              <p className="text-sm text-slate-300 leading-relaxed">
                {unpaidPlayers.map((p: { full_name: string }) => p.full_name).sort().join(', ')}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <AdminCard
          href="/admin/config"
          title="Pool Configuration"
          desc="Competition format, season, pick frequency, deadlines, reuse and tiebreak rules"
        />
        <AdminCard
          href="/admin/schedule"
          title="Enter Schedule"
          desc="Load days from ESPN, or add a game by hand"
        />
        <AdminCard
          href="/admin/results"
          title="Enter Results"
          desc="Enter game outcomes — the app auto-grades picks and eliminates players"
        />
        <AdminCard
          href="/admin/players"
          title="Manage Players"
          desc="Import CSV, toggle paid status, reset passwords, correct eliminations, submit picks"
        />
        <AdminCard
          href="/admin/recap"
          title="Weekly Recap"
          desc="Generate copy-pasteable recap text for GroupMe"
        />
        <AdminCard
          href="/admin/history"
          title="Season History"
          desc="Every slate's games, results, pick counts, and eliminations in one view"
        />
        <AdminCard
          href="/admin/email"
          title="Email Players"
          desc="Broadcast a message to everyone, alive players, or those missing a pick"
        />
        <AdminCard
          href="/admin/testing"
          title="Testing Mode"
          desc="Black-box sandbox with its own test users and schedule — rehearse the full game flow without touching real data"
        />
      </div>

      {/* Data export */}
      <div className="rounded-xl border border-slate-700 bg-slate-800 p-4">
        <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-3">Data Export</p>
        <div className="flex flex-wrap gap-3">
          <a
            href="/api/admin/export?type=players"
            className="rounded-lg border border-slate-600 bg-slate-700 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-600 transition-colors"
          >
            Export Players CSV
          </a>
          <a
            href="/api/admin/export?type=picks"
            className="rounded-lg border border-slate-600 bg-slate-700 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-600 transition-colors"
          >
            Export Picks CSV
          </a>
        </div>
      </div>

      {allWeeks && allWeeks.length > 0 && <SetActiveWeek slates={allWeeks} />}

      <ResetPoolButton />
    </div>
  )
}

function ResultBadge({ result, home, away }: { result: string; home: string; away: string }) {
  if (result === 'pending') return <span className="text-xs text-amber-400">pending</span>
  if (result === 'home_win') return <span className="text-xs font-semibold text-green-400">{home} won</span>
  if (result === 'away_win') return <span className="text-xs font-semibold text-green-400">{away} won</span>
  return <span className="text-xs font-semibold text-red-400">tie</span>
}

function StatCard({
  label,
  value,
  color = 'text-white',
}: {
  label: string
  value: string | number
  color?: string
}) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800 p-4 text-center">
      <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color}`}>{value}</p>
    </div>
  )
}

function AdminCard({
  href,
  title,
  desc,
}: {
  href: string
  title: string
  desc: string
}) {
  return (
    <Link
      href={href}
      className="block rounded-xl border border-slate-700 bg-slate-800 p-5 hover:border-slate-500 hover:bg-slate-700/50 transition-all"
    >
      <p className="font-semibold text-white">{title}</p>
      <p className="text-slate-400 text-sm mt-1">{desc}</p>
    </Link>
  )
}
