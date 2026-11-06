import type { Metadata } from 'next'
import { Saira_Condensed, Source_Sans_3 } from 'next/font/google'
import './globals.css'
import { siteUrl, socialImage } from '@/lib/site'
import SiteAnalytics from './components/SiteAnalytics'
import TestModeBanner from './components/TestModeBanner'

// Two typefaces site-wide: Saira Condensed for titles, scores and big numbers
// (one heavy weight); Source Sans 3 for everything else (variable, one file).
const saira = Saira_Condensed({ subsets: ['latin'], weight: ['800'], variable: '--font-saira' })
const source = Source_Sans_3({ subsets: ['latin'], variable: '--font-source' })

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: 'Pick and Pray: College Basketball Survivor', template: '%s | Pick and Pray' },
  description: 'Pick a college basketball winner each game day. Win and advance. Lose and you’re out.',
  icons: { icon: [{ url: '/favicon.png', type: 'image/png' }], apple: '/apple-icon.png' },
  openGraph: { siteName: 'Pick and Pray', type: 'website', images: [socialImage] },
  twitter: { card: 'summary_large_image', images: [socialImage] },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-scroll-behavior="smooth" className={`${saira.variable} ${source.variable}`}>
      <body className="min-h-full antialiased">
        <a href="#main" className="skip-link">Skip to content</a>
        <TestModeBanner />
        <SiteAnalytics />
        {children}
      </body>
    </html>
  )
}
