import Link from 'next/link'
import InfoPage from './components/InfoPage'
import Basketball404 from './components/Basketball404'

export default function NotFound() {
  return <InfoPage title="Page not found">
    <p>That page doesn’t exist. The link may be old or mistyped.</p>
    <Link className="btn-primary px-6 py-3" href="/">Back to the pool</Link>
    <Basketball404 />
  </InfoPage>
}
