import type { CompetitionMode } from '@/lib/competition'
import { themeStyle } from '@/lib/poolTheme'
import SiteHeader from './SiteHeader'
import LiveTicker from './LiveTicker'
import TrustFooter from './TrustFooter'
import s from './pp.module.css'

// The frame every pool page shares: mode colors, header, score ticker, footer.
export default function PoolShell({
  mode,
  seasonYear,
  account,
  signupsClosed,
  names,
  width = 'wide',
  children,
}: {
  mode: CompetitionMode
  seasonYear?: number | null
  account?: string
  signupsClosed?: boolean
  names?: Record<string, string>
  width?: 'wide' | 'mid' | 'narrow'
  children: React.ReactNode
}) {
  const widthClass = width === 'mid' ? s.mainMid : width === 'narrow' ? s.mainNarrow : ''
  return (
    <div className={s.shell} style={themeStyle(mode)} data-mode={mode}>
      <SiteHeader mode={mode} seasonYear={seasonYear} account={account} signupsClosed={signupsClosed} />
      <LiveTicker names={names} />
      <main id="main" className={`${s.main} ${widthClass}`}>{children}</main>
      <TrustFooter />
    </div>
  )
}
