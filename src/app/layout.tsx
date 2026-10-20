import type { Metadata } from 'next'
import { Geist, Barlow_Condensed, Manrope, Saira_Condensed, Source_Sans_3 } from 'next/font/google'
import './globals.css'
import { siteUrl, socialImage } from '@/lib/site'
import SiteAnalytics from './components/SiteAnalytics'
import TestModeBanner from './components/TestModeBanner'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' })
const display = Barlow_Condensed({ subsets: ['latin'], weight: ['600', '700'], variable: '--concept-display' })
const text = Manrope({ subsets: ['latin'], variable: '--concept-text' })
// The pool pages: Saira Condensed for titles, scores and big numbers only;
// Source Sans 3 for everything else.
const saira = Saira_Condensed({ subsets: ['latin'], weight: ['600', '700', '800'], variable: '--font-saira' })
const source = Source_Sans_3({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-source' })

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: 'Pick and Pray — College Basketball Survivor', template: '%s | Pick and Pray' },
  description: 'Pick a college basketball winner each game day. Win and advance. Lose and you’re out.',
  icons: { icon: [{ url: '/mark.svg', type: 'image/svg+xml' }, { url: '/favicon.png', type: 'image/png' }], apple: '/apple-icon.png' },
  openGraph: { siteName: 'Madness', type: 'website', images: [socialImage] },
  twitter: { card: 'summary_large_image', images: [socialImage] },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${display.variable} ${text.variable} ${saira.variable} ${source.variable}`}>
      <body className="min-h-full antialiased">
        <a href="#main" className="skip-link">Skip to content</a>
        <TestModeBanner />
        <SiteAnalytics />
        {children}
      </body>
    </html>
  )
}
