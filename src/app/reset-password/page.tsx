import { pageMetadata } from '@/lib/site'
import Link from 'next/link'
import AuthShell from '@/app/components/AuthShell'
import ResetPasswordForm from './reset-password-form'
import s from '@/app/components/pp.module.css'

export const metadata = pageMetadata('Reset Your Password', 'Choose a new password using your Pick and Pray recovery link.', '/reset-password', false)

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>
}) {
  const { token } = await searchParams
  return (
    <AuthShell title="Choose a new password" links={[<Link key="login" href="/login">Back to log in</Link>]}>
      {typeof token === 'string' && token ? (
        <ResetPasswordForm token={token} />
      ) : (
        <p className={s.authError}>This reset link isn’t valid. Ask the organizer for a new one.</p>
      )}
    </AuthShell>
  )
}
