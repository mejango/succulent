import { Feed } from '@/components/Feed'
import { getFeedPage } from '@/lib/bendystraw'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const page = await getFeedPage(0).catch((error: unknown) => {
    console.error('activity unavailable', error)
    return { events: [], hasMore: false, fetchedAt: 0 }
  })
  return (
    <main className="mx-auto max-w-xl pb-[env(safe-area-inset-bottom)]">
      <Feed initial={page} />
    </main>
  )
}
