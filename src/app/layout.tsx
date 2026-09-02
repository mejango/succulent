import type { Metadata, Viewport } from 'next'
import { IBM_Plex_Mono, IBM_Plex_Sans, Young_Serif } from 'next/font/google'
import './globals.css'
import { Providers } from '@/components/Providers'

const siteOrigin = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3004'
const title = 'Succulent'
const description = 'Every Juicebox payment, cash out, and rule change, as it lands.'

const youngSerif = Young_Serif({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-young-serif',
  display: 'swap',
})
const plex = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex',
  display: 'swap',
})
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  title,
  description,
  icons: { icon: '/icon.svg' },
  openGraph: { title, description, url: '/', type: 'website' },
}

export const viewport: Viewport = {
  themeColor: '#E4EAE2',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${youngSerif.variable} ${plex.variable} ${plexMono.variable}`}>
      <body className="min-h-svh">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
