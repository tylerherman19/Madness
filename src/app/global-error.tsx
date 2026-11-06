'use client'

import Link from 'next/link'

export default function GlobalError({ unstable_retry }: { unstable_retry: () => void }) {
  return <html lang="en"><body style={{ margin: 0, padding: '48px 24px', background: '#F7F7F4', color: '#1E2227', fontFamily: "'Source Sans 3', system-ui, sans-serif" }}>
    <title>Page unavailable | Pick and Pray</title>
    <h1>The pool didn’t load</h1>
    <p role="alert">Something went wrong on our end. Try again in a moment.</p>
    <button style={{ padding: '12px 20px', fontSize: 16, fontWeight: 600, color: '#FFFFFF', background: '#B84A12', border: 0, borderRadius: 6, cursor: 'pointer' }} onClick={() => unstable_retry()}>Try again</button>
    <p><Link href="/" style={{ color: '#B84A12' }}>Back to the pool</Link></p>
    <p><Link href="/contact" style={{ color: '#B84A12' }}>Contact the organizer</Link></p>
  </body></html>
}
