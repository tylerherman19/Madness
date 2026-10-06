import { AdminSkeleton } from '@/app/components/PageSkeletons'

// Renders inside the admin layout, so the rail stays put while a page loads.
export default function Loading() {
  return <AdminSkeleton />
}
