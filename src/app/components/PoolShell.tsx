import type { CompetitionMode } from '@/lib/competition'
import { themeStyle } from '@/lib/poolTheme'
import { isTestMode } from '@/lib/testMode'
import SiteHeader from './SiteHeader'
import LiveTicker from './LiveTicker'
import TrustFooter from './TrustFooter'
import s from './pp.module.css'

// The frame every pool page shares: mode colors, header, score ticker, footer.
// The ticker reads team names from its own feed, so pages send none.
export default async function PoolShell({
  mode,
  seasonYear,
  account,
  signupsClosed,
  width = 'wide',
  children,
}: {
  mode: CompetitionMode
  seasonYear?: number | null
  account?: string
  signupsClosed?: boolean
  width?: 'wide' | 'mid' | 'narrow'
  children: React.ReactNode
}) {
  // Draft-mode gated, so cached pages stay cached.
  const sandbox = await isTestMode()
  const widthClass = width === 'mid' ? s.mainMid : width === 'narrow' ? s.mainNarrow : ''
  return (
    <div className={s.shell} style={themeStyle(mode)} data-mode={mode}>
      <SiteHeader mode={mode} seasonYear={seasonYear} account={account} signupsClosed={signupsClosed} />
      <LiveTicker sandbox={sandbox} />
      <main id="main" className={`${s.main} ${widthClass}`}>{children}</main>
      <TrustFooter />
    </div>
  )
}
