import Link from 'next/link'
import InfoPage from './components/InfoPage'
import Basketball404 from './components/Basketball404'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Page not found', robots: { index: false, follow: false } }

export default function NotFound() {
  return <InfoPage title="That page is out of bounds">
    <p>404 · We couldn’t find the page you requested. There’s always another possession.</p>
    <Basketball404 />
    <Link className="btn-primary px-6 py-3" href="/">Back to the pool</Link>
  </InfoPage>
}
