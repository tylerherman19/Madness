import PoolThemeScope from '@/app/components/PoolThemeScope'

// Same for every visitor: built ahead, refreshed every minute (see PoolThemeScope).
export const revalidate = 60

export default function Layout({ children }: { children: React.ReactNode }) { return <PoolThemeScope prerender>{children}</PoolThemeScope> }
