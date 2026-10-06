'use client'

import Link from 'next/link'

export default function GlobalError({ unstable_retry }: { unstable_retry: () => void }) {
  return <html lang="en"><body style={{ margin: 0, padding: '48px 24px', background: 'var(--paper, #f4f7fb)', color: 'var(--ink, #0d1c34)', fontFamily: 'Arial, sans-serif' }}>
    <title>Page unavailable | Madness</title>
    <h1>MADNESS · The board hit a timeout</h1>
    <p role="alert">We couldn’t load the pool. Please try again.</p>
    <button style={{ padding: '12px 20px', fontSize: 16 }} onClick={() => unstable_retry()}>Try again</button>
    <p><Link href="/">Back to the pool</Link> · <Link href="/contact">Contact the organizer</Link></p>
  </body></html>
}
