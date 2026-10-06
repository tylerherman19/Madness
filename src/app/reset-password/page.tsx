import { pageMetadata } from '@/lib/site'
import Link from 'next/link'
import AuthShell from '@/app/components/AuthShell'
import ResetPasswordForm from './reset-password-form'

export const metadata = pageMetadata('Reset Your Password', 'Choose a new password using your Madness account recovery link.', '/reset-password', false)

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>
}) {
  const { token } = await searchParams
  return (
    <AuthShell eyebrow="Account recovery" title="Choose a new password">
      {typeof token === 'string' && token ? (
        <ResetPasswordForm token={token} />
      ) : (
        <p className="text-sm" style={{ color: 'var(--danger)' }}>This reset link is invalid.</p>
      )}
      <Link href="/login" className="mt-6 block text-center text-sm font-bold underline" style={{ color: 'var(--muted)' }}>Back to log in</Link>
    </AuthShell>
  )
}
