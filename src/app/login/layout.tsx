import { pageMetadata } from '@/lib/site'
import PoolThemeScope from '@/app/components/PoolThemeScope'
export const metadata = pageMetadata('Log In', 'Log in to your Pick and Pray survivor pool entry.', '/login', false)

export default function Layout({ children }: { children: React.ReactNode }) { return <PoolThemeScope>{children}</PoolThemeScope> }
