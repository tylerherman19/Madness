import type { MetadataRoute } from 'next'
import { siteUrl } from '@/lib/site'

export default function sitemap(): MetadataRoute.Sitemap {
  return ['/', '/schedule', '/sweat', '/grid', '/privacy', '/terms', '/contact'].map(path => ({ url: `${siteUrl}${path}`, changeFrequency: path === '/' || ['/schedule', '/sweat', '/grid'].includes(path) ? 'daily' : 'yearly' }))
}
