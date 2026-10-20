import { permanentRedirect } from 'next/navigation'

// The sweat board moved to /sweat; old links and bookmarks still land on it.
export default function LivePage() {
  permanentRedirect('/sweat')
}
