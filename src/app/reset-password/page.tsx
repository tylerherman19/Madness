import { pageMetadata } from '@/lib/site'
import Link from 'next/link'
import AuthShell from '@/app/components/AuthShell'
import ResetPasswordForm from './reset-password-form'

export const metadata = pageMetadata('Reset Your Password', 'Choose a new password using your Pick and Pray recovery link.', '/reset-password', false)

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>
}) {
  const { token } = await searchParams
  return (
    <AuthShell title="Choose a new password" links={[<Link key="login" href="/login">Back to log in</Link>]}>
      {/* Organizer links carry the token in the URL fragment (never sent to
          the server); older links used ?token=. The form reads either. */}
      <ResetPasswordForm token={typeof token === 'string' ? token : undefined} />
    </AuthShell>
  )
}
