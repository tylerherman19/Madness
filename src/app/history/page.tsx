import { redirect } from 'next/navigation'

// This page was retired; old links land on Today.
export default function RetiredPage() {
  redirect('/')
}
