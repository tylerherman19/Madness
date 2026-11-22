'use client'

import Link from 'next/link'
import InfoPage from './components/InfoPage'
import { supportEmail } from '@/lib/site'

export default function ErrorPage({ unstable_retry }: { unstable_retry: () => void }) {
  return <InfoPage title="This page didn’t load">
    <p role="alert">Try again. If it keeps happening, <a href={`mailto:${supportEmail}`}>contact the organizer</a>.</p>
    <button className="btn-primary px-6 py-3" onClick={() => unstable_retry()}>Try again</button>
    <p><Link href="/">Back to the pool</Link></p>
  </InfoPage>
}
