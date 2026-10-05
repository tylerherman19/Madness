import type { Metadata } from 'next'

// Set NEXT_PUBLIC_APP_URL to the primary production domain when using a custom domain.
export const siteUrl = new URL(process.env.NEXT_PUBLIC_APP_URL || 'https://madness-cyan.vercel.app').origin
export const supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'pool@pickandpray.org'
export const socialImage = { url: '/opengraph-image', width: 1200, height: 630, alt: 'MADNESS — College Basketball Survivor. One pick. Every game day.' }

export function pageMetadata(title: string, description: string, path: string, index = true): Metadata {
  const url = new URL(path, siteUrl).toString()
  return {
    title: { absolute: `${title} | Madness` }, description,
    alternates: { canonical: url },
    openGraph: { title: `${title} | Madness`, description, url, siteName: 'Madness', type: 'website', images: [socialImage] },
    twitter: { card: 'summary_large_image', title: `${title} | Madness`, description, images: [socialImage] },
    ...(!index ? { robots: { index: false, follow: false } } : {}),
  }
}
