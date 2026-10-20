import PoolLoading from './components/PoolLoading'

// Fallback for pages without their own loading screen (sign-in, info pages).
export default function Loading() {
  return <PoolLoading variant="page" />
}
