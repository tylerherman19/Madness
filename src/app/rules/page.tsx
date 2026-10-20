import { permanentRedirect } from 'next/navigation'

// The rules now live at the bottom of the Today page.
export default function RulesPage() {
  permanentRedirect('/#rules')
}
