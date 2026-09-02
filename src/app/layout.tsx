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
        {/* iOS Safari zooms the page when focus lands in a field, including the field a <dialog> focuses as it
            opens. Capping maximum-scale stops that; iOS still allows pinch zoom regardless (since iOS 10), so
            accessibility is unaffected. Applied to iOS only so Android keeps its default pinch behavior. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "if(/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1)){var m=document.querySelector('meta[name=viewport]');if(m)m.setAttribute('content',m.getAttribute('content')+', maximum-scale=1');}",
          }}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
