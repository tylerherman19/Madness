import { redirect } from 'next/navigation'

// The old Operations page is now the System status page.
export default function Operations() {
  redirect('/admin/system')
}
