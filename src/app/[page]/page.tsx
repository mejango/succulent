import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Feed } from '@/components/Feed'
import { findPinnedPage, getFeedPage } from '@/lib/bendystraw'
import { parsePageRef } from '@/lib/chains'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ page: string }> }

async function resolve(segment: string) {
  const ref = parsePageRef(segment)
  return ref ? findPinnedPage(ref) : null
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const pinned = await resolve((await params).page).catch(() => null)
  return pinned ? { title: `${pinned.name} on Succulent`, description: `Every payment, cash out, and rule change on ${pinned.name}, as it lands.` } : {}
}

/** The feed pinned to one page, addressable as /<handle> or /<chain>:<projectId>. */
export default async function PinnedPage({ params }: Props) {
  const pinned = await resolve((await params).page).catch(() => null)
  if (!pinned) notFound()
  const feed = await getFeedPage(0, pinned.group).catch((error: unknown) => {
    console.error('activity unavailable', error)
    return { events: [], hasMore: false, fetchedAt: 0 }
  })
  return (
    <main className="mx-auto max-w-xl pb-[env(safe-area-inset-bottom)]">
      <Feed initial={feed} initialPinned={pinned} />
    </main>
  )
}
