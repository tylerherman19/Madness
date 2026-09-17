import { teamColor } from '@/lib/teamColors'
import TeamChip from './TeamChip'
import type { ExposureModule, LeverageModule, ScarcityModule } from '@/lib/insights'

export function Story({ kicker, lede, deck, method, children, id }: {
  kicker: string
  lede?: string
  deck?: string
  method?: string
  children?: React.ReactNode
  id?: string
}) {
  return (
    <section id={id} className="pt-10">
      <p className="kicker">{kicker}</p>
      {lede && <h2 className="lede mt-2">{lede}</h2>}
      {deck && <p className="deck mt-2.5">{deck}</p>}
      {children && <div className="mt-5">{children}</div>}
      {method && <p className="method">{method}</p>}
    </section>
  )
}

export function ExposureFigure({ data }: { data: ExposureModule }) {
  const { rows, aliveCount, hiddenCount } = data
  const widthOf = (count: number) => `${(count / Math.max(aliveCount, 1)) * 100}%`

  return (
    <div className="card p-4 sm:p-5">
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.team} className="grid items-center" style={{ gridTemplateColumns: '58px 1fr 48px', columnGap: 12 }}>
            <TeamChip team={row.team} size={18} />
            <div className="bar-track" style={{ height: 15 }}>
              <div className="bar-fill" style={{ width: widthOf(row.count), background: teamColor(row.team).primary }} />
            </div>
            <span className="text-right text-sm font-bold tnum" style={{ color: 'var(--ink)' }}>{row.count}</span>
          </div>
        ))}
        {hiddenCount > 0 && (
          <div className="grid items-center" style={{ gridTemplateColumns: '58px 1fr 48px', columnGap: 12 }}>
            <span className="eyebrow" style={{ fontSize: 9 }}>Hidden</span>
            <div className="bar-track" style={{ height: 15 }}>
              <div className="bar-fill" style={{ width: widthOf(hiddenCount), background: 'repeating-linear-gradient(135deg, var(--border) 0 5px, var(--surface-sunken) 5px 10px)' }} />
            </div>
            <div className="text-right leading-tight">
              <span className="text-sm font-bold tnum" style={{ color: 'var(--muted)' }}>{hiddenCount}</span>
              <span className="block" style={{ fontSize: 10, color: 'var(--muted)' }}>unknown</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// Reusable for private analysis views. The public standings page does not
// render this section.
export function LeverageTable({ data, limit = 12 }: { data: LeverageModule; limit?: number }) {
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead><tr><th className="text-left p-3">Player</th><th className="text-left p-3">Pick</th><th className="text-right p-3">Best case</th></tr></thead>
        <tbody>
          {data.rows.slice(0, limit).map((row) => (
            <tr key={row.player_id} style={{ borderTop: '1px solid var(--border)' }}>
              <td className="p-3 font-semibold">{row.full_name}</td>
              <td className="p-3"><TeamChip team={row.team} size={18} /></td>
              <td className="p-3 text-right tnum">{row.bestCaseField} left</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const BURN_STEPS = ['var(--burn-0)', 'var(--burn-1)', 'var(--burn-2)', 'var(--burn-3)', 'var(--burn-4)', 'var(--burn-5)']

function burnStep(share: number): number {
  if (share <= 0) return 0
  if (share <= 0.2) return 1
  if (share <= 0.4) return 2
  if (share <= 0.6) return 3
  if (share <= 0.8) return 4
  return 5
}

export function BurnMap({ data }: { data: ScarcityModule }) {
  const { rows, aliveCount, uniqueHolds, exhausted } = data
  const sorted = [...rows].sort((a, b) => b.burnedBy - a.burnedBy || a.team.localeCompare(b.team))

  return (
    <div className="space-y-3">
      <div className="card p-4 sm:p-5">
        <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5">
          {sorted.map((row) => {
            const step = burnStep(aliveCount > 0 ? row.burnedBy / aliveCount : 0)
            const onDark = step >= 4
            return (
              <div key={row.team} className="burn-cell hint" style={{ background: BURN_STEPS[step] }}>
                <span className="block text-[11px] font-extrabold leading-none" style={{ color: onDark ? 'var(--cream)' : 'var(--ink)' }}>{row.team}</span>
                <span className="block tnum leading-none mt-1 font-bold" style={{ fontSize: 9.5, color: onDark ? 'var(--cream)' : 'var(--ink-2)' }}>{row.availableTo}</span>
                <span className="hint-body">{row.team} · {row.burnedBy} of {aliveCount} survivors have spent it</span>
              </div>
            )
          })}
        </div>
        <div className="mt-4 flex items-center gap-2 flex-wrap">
          <span className="eyebrow" style={{ fontSize: 9 }}>Spent by</span>
          <span className="text-[10px]" style={{ color: 'var(--muted)' }}>none</span>
          <span className="flex gap-0.5">
            {BURN_STEPS.map((color) => <span key={color} style={{ background: color, width: 22, height: 10, borderRadius: 2 }} />)}
          </span>
          <span className="text-[10px]" style={{ color: 'var(--muted)' }}>all {aliveCount}</span>
          <span className="text-[10px] ml-1" style={{ color: 'var(--muted)' }}>· small number = survivors who can still play it</span>
        </div>
      </div>
      {(uniqueHolds.length > 0 || exhausted.length > 0) && (
        <div className="card p-4 sm:p-5 grid sm:grid-cols-2 gap-x-8 gap-y-4">
          {uniqueHolds.length > 0 && (
            <div>
              <p className="eyebrow mb-2">Last one holding it</p>
              <ul className="space-y-1.5">
                {uniqueHolds.slice(0, 6).map((item) => (
                  <li key={item.team} className="flex items-center gap-2.5 text-sm"><TeamChip team={item.team} size={18} /><span style={{ color: 'var(--ink-2)' }}>{item.holder}</span></li>
                ))}
              </ul>
            </div>
          )}
          {exhausted.length > 0 && (
            <div>
              <p className="eyebrow mb-2">Off the board for everyone</p>
              <div className="flex flex-wrap gap-1.5">
                {exhausted.map((team) => <span key={team} className="text-[11px] font-bold px-2 py-1 rounded" style={{ background: 'var(--surface-sunken)', color: 'var(--muted)', textDecoration: 'line-through' }}>{team}</span>)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
