import { NextResponse } from 'next/server'
import { searchPages } from '@/lib/bendystraw'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const query = (params.get('q') ?? '').trim().slice(0, 64)
  const owner = params.get('owner')
  try {
    return NextResponse.json(await searchPages(query, owner && /^0x[0-9a-fA-F]{40}$/.test(owner) ? owner : null))
  } catch {
    return NextResponse.json({ mine: [], found: [] }, { status: 502 })
  }
}
