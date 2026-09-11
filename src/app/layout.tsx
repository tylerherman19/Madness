import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import './globals.css'
import TestModeBanner from './components/TestModeBanner'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' })

export const metadata: Metadata = {
  title: { default: 'Madness', template: '%s | Madness' },
  description: "College basketball survivor. Pick one team each game day. Win and advance. Lose and you're out.",
  icons: { icon: '/mark.svg' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={geist.variable}>
      <body className="min-h-full antialiased">
        <TestModeBanner />
        {children}
      </body>
    </html>
  )
}
