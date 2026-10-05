'use client'

import Link from 'next/link'
import InfoPage from './components/InfoPage'

export default function ErrorPage({ unstable_retry }: { unstable_retry: () => void }) {
  return <InfoPage title="The board hit a timeout">
    <p role="alert">We couldn’t load this page. Try again, or contact the organizer if the problem continues.</p>
    <button className="btn-primary px-6 py-3" onClick={() => unstable_retry()}>Try again</button>
    <p><Link href="/">Back to the pool</Link> · <Link href="/contact">Contact the organizer</Link></p>
  </InfoPage>
}
