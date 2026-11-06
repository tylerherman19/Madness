import { pageMetadata } from '@/lib/site'
import PoolThemeScope from '@/app/components/PoolThemeScope'

// Same for every visitor: built ahead, refreshed every minute (see PoolThemeScope).
export const revalidate = 60
export const metadata = pageMetadata('Log In', 'Log in to your Pick and Pray survivor pool entry.', '/login', false)

export default function Layout({ children }: { children: React.ReactNode }) { return <PoolThemeScope prerender>{children}</PoolThemeScope> }
