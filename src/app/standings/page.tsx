import { permanentRedirect } from 'next/navigation'

// Standings now live on the home page.
export default function StandingsPage() {
  permanentRedirect('/#standings')
}
