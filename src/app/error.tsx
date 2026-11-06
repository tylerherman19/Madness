'use client'

import Link from 'next/link'
import InfoPage from './components/InfoPage'

export default function ErrorPage({ unstable_retry }: { unstable_retry: () => void }) {
  return <InfoPage title="This page didn’t load">
    <p role="alert">Try again. If it keeps happening, <Link href="/contact">contact the organizer</Link>.</p>
    <button className="btn-primary px-6 py-3" onClick={() => unstable_retry()}>Try again</button>
    <p><Link href="/">Back to the pool</Link></p>
  </InfoPage>
}
