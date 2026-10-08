import Link from 'next/link'
import InfoPage from '../components/InfoPage'
import { pageMetadata, supportEmail } from '@/lib/site'

export const metadata = pageMetadata('Privacy Policy', 'How Madness uses player information, necessary cookies, analytics, and pool records.', '/privacy')

export default function PrivacyPage() {
  return <InfoPage title="Privacy Policy">
    <p>Effective October 7, 2026. This policy covers the MADNESS college basketball survivor website operated by the pool organizer.</p>
    <h2>Information we collect</h2>
    <p>When you join, we collect your name, email address, phone number, Venmo handle, and password. We also store payment status, picks, pick times, survival/elimination status, and administrator audit records. Payment is handled separately by Venmo; we do not collect card or bank account details through this site.</p>
    <h2>How information is used and displayed</h2>
    <p>We use these records to run the pool, authenticate players, manage payments and payouts, enforce pick deadlines, resolve disputes, and support accounts. Player names, standings, and pick history can be visible to other visitors. Picks are hidden until the applicable lock time. Email addresses, phone numbers, and Venmo handles are not part of the public standings or pick grid.</p>
    <p>If enabled by the organizer, operational emails may include pick confirmations, reminders, pool updates, and password reset links. We do not sell player information or use it for advertising.</p>
    <h2>Cookies and analytics</h2>
    <p>Essential cookies maintain player and administrator sessions and, when used, the testing sandbox. They are needed for these features; blocking them prevents signed-in use. Player sessions expire after 30 days and administrator sessions after 8 hours. Signing out removes the relevant session cookie.</p>
    <p>We use Vercel Web Analytics when enabled on the deployment to measure page views and general usage, such as browser, device, and referring site. This analytics tool does not use analytics cookies. We do not send account fields or URL query strings to analytics, and exclude account, administrator, and API routes. No advertising trackers are installed.</p>
    <h2>Retention and your requests</h2>
    <p>Pool and audit records are kept for operating the competition, history, payment reconciliation, and resolving disputes. There is no automatic deletion schedule in the app. Contact the organizer to request access, correction, export, or deletion. Some records may need to remain for outstanding payments, disputes, or legal obligations; deleted records may remain in provider backups until those backups expire.</p>
    <h2>Contact and changes</h2>
    <p>Email <a href={`mailto:${supportEmail}`}>{supportEmail}</a> with privacy questions or requests. The organizer may update this policy and will change the effective date here. See also our <Link href="/terms">Terms of Use</Link>.</p>
  </InfoPage>
}
