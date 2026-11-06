import { connection } from 'next/server'
import { getPoolConfig } from '@/lib/pool'
import { themeStyle } from '@/lib/poolTheme'
import { PoolModeProvider } from './PoolMode'
import s from './pp.module.css'

// Wraps pages that don't load pool data themselves (log in, sign up, password
// reset) in the active mode's colors. Read per request so a mode switch in
// admin shows up at once — except with `prerender`, for pages whose content is
// the same for everyone (privacy, terms, contact, log in). Those are built
// ahead and refreshed every minute (their layout's `revalidate`), and saving
// the pool settings in admin refreshes them immediately.
export default async function PoolThemeScope({ children, prerender = false }: { children: React.ReactNode; prerender?: boolean }) {
  if (!prerender) await connection()
  const pool = await getPoolConfig()
  return (
    <PoolModeProvider mode={pool.competition_mode} seasonYear={pool.season_year}>
      <div className={s.shell} style={themeStyle(pool.competition_mode)} data-mode={pool.competition_mode}>{children}</div>
    </PoolModeProvider>
  )
}
