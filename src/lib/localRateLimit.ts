type Bucket = { count: number; expires: number }
export function createLocalRateLimiter(maxKeys = 10000) {
  const buckets = new Map<string, Bucket>()
  return (key: string, maxRequests: number, windowSeconds: number, now = Date.now()): boolean => {
    for (const [storedKey, bucket] of buckets) if (bucket.expires <= now) buckets.delete(storedKey)
    const bucket = buckets.get(key)
    if (bucket) {
      if (bucket.count >= maxRequests) return false
      bucket.count++
      return true
    }
    if (buckets.size >= maxKeys) return false
    buckets.set(key, { count: 1, expires: now + windowSeconds * 1000 })
    return true
  }
}
export const localRateLimit = createLocalRateLimiter()
