import Link from 'next/link'
import { supportEmail } from '@/lib/site'

export default function TrustFooter() {
  return <footer className="trust-footer">
    <div className="trust-footer-top">
      <p><strong>MADNESS</strong><br />College Basketball Survivor</p>
      <nav aria-label="Footer">
        <Link href="/standings#rules">Pool rules</Link>
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/contact">Contact</Link>
      </nav>
      <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
    </div>
    <p>Independent survivor pool. Not affiliated with or endorsed by the NCAA, any conference, university, team, or Venmo. You are responsible for following the laws where you live and participate. Do not enter or pay where participation is prohibited.</p>
    <p>Odds and lines are informational snapshots, may change or be delayed, and are not offers to place a bet. Displayed prices are as observed; no outcome or payout is guaranteed.</p>
    <p>Kohl Center photo: <a href="https://commons.wikimedia.org/wiki/File:Kohl_Center,_Madison,_WI_1-5-2012_262_(6791215446).jpg">Richard Hurd</a>, <a href="https://creativecommons.org/licenses/by/2.0/">CC BY 2.0</a>. Resized, responsively cropped, and darkened with overlays.</p>
  </footer>
}
