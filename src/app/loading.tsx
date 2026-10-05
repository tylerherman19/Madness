import InfoPage from './components/InfoPage'

export default function Loading() {
  return <InfoPage title="Getting the board ready">
    <p role="status" aria-live="polite">Loading MADNESS pool information…</p>
    <div className="loading-board" aria-hidden="true"><span /><span /><span /></div>
  </InfoPage>
}
