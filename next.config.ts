import type { NextConfig } from 'next'

const isDev = process.env.NODE_ENV === 'development'
// Next.js hydration uses inline scripts; the app also uses inline style attributes.
// A nonce policy would force dynamic rendering and remove the existing ISR cache.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://a.espncdn.com https://a1.espncdn.com https://a2.espncdn.com https://a3.espncdn.com https://a4.espncdn.com",
  "font-src 'self'",
  `connect-src 'self' https://vitals.vercel-insights.com${isDev ? ' ws: wss:' : ''}`,
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
  ...(!isDev ? ['upgrade-insecure-requests'] : []),
].join('; ')

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  ...(!isDev ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000' }] : []),
]

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() { return [{ source: '/(.*)', headers: securityHeaders }] },
}
export default nextConfig
