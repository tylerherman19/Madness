import type { CompetitionMode } from '@/lib/competition'
import type { PickState } from '@/lib/viewerState'
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
  pick,
  hideAction,
  signupsClosed,
  width = 'wide',
  children,
}: {
  mode: CompetitionMode
  seasonYear?: number | null
  // From pages that read the session: the name (null when signed out) and
  // where the entry stands. Pages built ahead for everyone leave both out.
  account?: string | null
  pick?: PickState
  hideAction?: boolean
  signupsClosed?: boolean
  width?: 'wide' | 'narrow'
  children: React.ReactNode
}) {
  // Draft-mode gated, so cached pages stay cached.
  const sandbox = await isTestMode()
  const widthClass = width === 'narrow' ? s.mainNarrow : ''
  return (
    <div className={s.shell} style={themeStyle(mode)} data-mode={mode}>
      <SiteHeader mode={mode} seasonYear={seasonYear} account={account} pick={pick} hideAction={hideAction} signupsClosed={signupsClosed} />
      <LiveTicker sandbox={sandbox} />
      <main id="main" className={`${s.main} ${widthClass}`}>{children}</main>
      <TrustFooter />
    </div>
  )
}
