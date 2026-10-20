import type { MetadataRoute } from 'next'
import { siteUrl } from '@/lib/site'

export default function sitemap(): MetadataRoute.Sitemap {
  return ['/', '/schedule', '/standings', '/sweat', '/rules', '/grid', '/privacy', '/terms', '/contact'].map(path => ({ url: `${siteUrl}${path}`, changeFrequency: path === '/' || ['/schedule', '/standings', '/sweat', '/grid'].includes(path) ? 'daily' : 'yearly' }))
}
