import Link from 'next/link'
import InfoPage from '../components/InfoPage'
import { pageMetadata, supportEmail } from '@/lib/site'

export const metadata = pageMetadata('Contact', 'Reach the Madness pool organizer for account, payment, privacy, or pool questions.', '/contact')

export default function ContactPage() {
  return <InfoPage title="Contact the organizer">
    <p>For account access, payment questions, a disputed pick, refunds, or a privacy request, email <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.</p>
    <p>Include your player name and the game day involved so the organizer can locate your entry. Never send your password, a password reset link, or banking details.</p>
    <h2>Payments and pool rules</h2>
    <p>The current entry fee is $25, paid separately through Venmo to @griffinsell. Account creation does not process a payment. Confirm payment, payout, and refund arrangements with the organizer before sending money.</p>
    <p>Read the <Link href="/standings#rules">active pool rules</Link>, <Link href="/terms">Terms of Use</Link>, and <Link href="/privacy">Privacy Policy</Link>.</p>
  </InfoPage>
}
