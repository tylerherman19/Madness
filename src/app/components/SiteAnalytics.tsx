'use client'

import { Analytics } from '@vercel/analytics/next'

export default function SiteAnalytics() {
  return <Analytics debug={false} beforeSend={event => {
    const url = new URL(event.url)
    if (/^\/(admin|api|login|signup|pick|history|forgot-pin|reset-password)(\/|$)/.test(url.pathname)) return null
    url.search = ''
    url.hash = ''
    return { ...event, url: url.toString() }
  }} />
}
