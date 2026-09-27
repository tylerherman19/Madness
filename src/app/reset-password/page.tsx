import Link from 'next/link'
import AuthShell from '@/app/components/AuthShell'
import ResetPasswordForm from './reset-password-form'

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>
}) {
  const { token } = await searchParams
  return (
    <AuthShell eyebrow="Account recovery" title="Choose a new password" description="Use the link sent to your email to set a new password.">
      {typeof token === 'string' && token ? (
        <ResetPasswordForm token={token} />
      ) : (
        <p className="text-sm" style={{ color: 'var(--red)' }}>This reset link is invalid.</p>
      )}
      <Link href="/login" className="mt-6 block text-center text-sm font-bold underline" style={{ color: 'var(--muted)' }}>Back to log in</Link>
    </AuthShell>
  )
}
