import Link from 'next/link'
import InfoPage from '../components/InfoPage'
import { pageMetadata, supportEmail } from '@/lib/site'

export const metadata = pageMetadata('Terms of Use', 'Madness entry fees, survivor rules, payment arrangements, eligibility, and dispute contact.', '/terms')

export default function TermsPage() {
  return <InfoPage title="Terms of Use">
    <p>Effective October 4, 2026. By creating an account or participating in MADNESS, you agree to these terms and the <Link href="/standings#rules">active pool rules</Link>.</p>
    <h2>Eligibility and local law</h2>
    <p>Participate only if you are legally eligible where you live and participate. You are responsible for checking applicable laws before joining or paying. Do not enter where this pool or its entry fee is prohibited. MADNESS does not provide legal advice.</p>
    <h2>Entry fee and payment</h2>
    <p>The current entry fee is $25, paid through Venmo to @griffinsell. Creating an account does not charge you or confirm payment. The organizer records payment status separately. Confirm your entry and payment instructions with the organizer before sending money; this website does not hold or automatically transfer funds.</p>
    <h2>Picks and results</h2>
    <p>Use one account per entry and provide accurate contact information. Follow the active competition’s required number of picks, reuse restrictions, and deadlines. Winning picks advance, losing picks eliminate, and picks lock at the period’s deadline. Automatic picks and tiebreakers depend on the active pool configuration shown in the pool rules.</p>
    <h2>Payouts, ties, and refunds</h2>
    <p>The survivor winner is determined under the active pool rules. The organizer manages the pot and pays winners outside this website. Confirm the payout amount, timing, treatment of any remaining tie, and refund or cancellation arrangements with the organizer before paying. This app does not publish a fixed refund schedule or automatically issue refunds; contact the organizer about a refund or disputed payment.</p>
    <h2>Availability and disputes</h2>
    <p>Game feeds, odds, and displayed information can be delayed or corrected. Do not rely on an uninterrupted connection to submit a last-second pick. Report incorrect results, missing payments, or access problems promptly, with your player name and game day. The organizer reviews pool disputes using the rules and stored records; these terms do not remove rights you have under applicable law.</p>
    <h2>Independent service and informational odds</h2>
    <p>MADNESS is not affiliated with or endorsed by the NCAA, any conference, university, team, or Venmo. Team names and marks identify the games and their respective owners. Odds and lines are informational, as observed, may change, and are not offers to place bets or promises of returns.</p>
    <h2>Privacy and contact</h2>
    <p>Read the <Link href="/privacy">Privacy Policy</Link> for the information used to operate the pool. Questions about these terms, payouts, or refunds can be sent to <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.</p>
  </InfoPage>
}
