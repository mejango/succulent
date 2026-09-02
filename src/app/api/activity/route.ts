import { NextResponse } from 'next/server'
import { getFeedPage } from '@/lib/bendystraw'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const offset = Number(params.get('offset'))
  const group = params.get('group')
  try {
    const page = await getFeedPage(
      Number.isSafeInteger(offset) && offset >= 0 ? Math.min(offset, 100_000) : 0,
      group && /^[0-9a-f]{32}$/i.test(group) ? group : null,
    )
    return NextResponse.json(page, {
      headers: { 'cache-control': 'public, max-age=5, stale-while-revalidate=30' },
    })
  } catch {
    return NextResponse.json({ events: [], hasMore: false, fetchedAt: 0 }, { status: 502 })
  }
}
