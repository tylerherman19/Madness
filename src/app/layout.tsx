import type { Metadata } from 'next'
import { Geist, Barlow_Condensed, Manrope } from 'next/font/google'
import './globals.css'
import TestModeBanner from './components/TestModeBanner'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' })
const display = Barlow_Condensed({ subsets: ['latin'], weight: ['600', '700'], variable: '--concept-display' })
const text = Manrope({ subsets: ['latin'], variable: '--concept-text' })

export const metadata: Metadata = {
  title: { default: 'Madness', template: '%s | Madness' },
  description: "College basketball survivor. Pick one team each game day. Win and advance. Lose and you're out.",
  icons: { icon: '/mark.svg' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${display.variable} ${text.variable}`}>
      <body className="min-h-full antialiased">
        <TestModeBanner />
        {children}
      </body>
    </html>
  )
}
