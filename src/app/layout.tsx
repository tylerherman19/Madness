import type { Metadata, Viewport } from 'next'
import { Geist, Barlow_Condensed, Manrope } from 'next/font/google'
import './globals.css'
import { siteUrl, socialImage } from '@/lib/site'
import SiteAnalytics from './components/SiteAnalytics'
import TestModeBanner from './components/TestModeBanner'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' })
const display = Barlow_Condensed({ subsets: ['latin'], weight: ['600', '700'], variable: '--concept-display' })
const text = Manrope({ subsets: ['latin'], variable: '--concept-text' })

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: 'Madness — College Basketball Survivor', template: '%s | Madness' },
  description: 'Pick a college basketball winner each game day. Win and advance. Lose and you’re out.',
  icons: { icon: [{ url: '/mark.svg', type: 'image/svg+xml' }, { url: '/favicon.png', type: 'image/png' }], apple: '/apple-icon.png' },
  openGraph: { siteName: 'Madness', type: 'website', images: [socialImage] },
  twitter: { card: 'summary_large_image', images: [socialImage] },
}

// viewport-fit=cover makes iOS report env(safe-area-inset-*), which the fixed
// mobile nav and pick dock already pad against; without it those insets are 0
// and the home indicator overlaps the controls.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0d1c34',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${display.variable} ${text.variable}`}>
      <body className="min-h-full antialiased">
        <TestModeBanner />
        <SiteAnalytics />
        {children}
      </body>
    </html>
  )
}
