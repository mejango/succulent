'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActivityEvent, FeedPage, PinnedPage } from '@/lib/bendystraw'
import { ACTIVITY_FILTERS, combinedActivityParts, groupSameTxEvents, type ActivityFilter } from '@/lib/activity'
import { addressUrl, chainIcon, chainName, chainSlug, pagePath, projectUrl, txUrl } from '@/lib/chains'
import { formatDate, formatTokenAmount, formatUsd18, projectLogoUrl, timeAgo, truncateAddress } from '@/lib/format'
import { Compose } from './Compose'

const POLL_MS = 15_000

async function fetchPage(offset: number, group: string | null, kind: ActivityFilter | null = null): Promise<FeedPage> {
  const response = await fetch(`/api/activity?offset=${offset}${group ? `&group=${group}` : ''}${kind ? `&kind=${kind}` : ''}`)
  if (!response.ok) throw new Error('Activity unavailable')
  return response.json()
}

function merge(current: ActivityEvent[], incoming: ActivityEvent[], prepend: boolean): ActivityEvent[] {
  const ids = new Set(incoming.map(event => event.id))
  const hashes = new Set(incoming.map(event => event.txHash))
  // A provisional row (a post shown before the indexer saw it) yields to the indexed row for its tx.
  const rest = current.filter(event => !ids.has(event.id) && !(event.id.startsWith('pending:') && hashes.has(event.txHash)))
  return prepend ? [...incoming, ...rest] : [...rest, ...incoming]
}

export function Feed({ initial, initialPinned = null }: { initial: FeedPage; initialPinned?: PinnedPage | null }) {
  const [events, setEvents] = useState(initial.events)
  const [hasMore, setHasMore] = useState(initial.hasMore)
  const [loading, setLoading] = useState(false)
  const [stale, setStale] = useState(false)
  // Server and client share one clock at hydration; each poll advances it.
  const [now, setNow] = useState(initial.fetchedAt)
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  const markerRef = useRef<HTMLLIElement>(null)
  /** A page the feed is pinned to (tap a logo or name), fetched by its sucker group so paging still works. */
  const [pinned, setPinnedState] = useState<PinnedPage | null>(initialPinned)
  // The address bar follows the pin so a filtered feed can be linked: /<handle>, /<chain>:<id>, or /.
  const setPinned = (next: PinnedPage | null) => {
    setPinnedState(next)
    window.history.replaceState(null, '', next ? pagePath(next) : '/')
  }
  const [category, setCategory] = useState<ActivityFilter | null>(null)
  const group = pinned?.group ?? null

  // Pinning a page or picking a category restarts the list from the top for that scope, from the indexer.
  useEffect(() => {
    if (pinned === initialPinned && category === null && events === initial.events) return
    let live = true
    setLoading(true)
    fetchPage(0, group, category)
      .then(page => {
        if (!live) return
        setEvents(page.events)
        setHasMore(page.hasMore)
        setNow(page.fetchedAt)
        setFresh(new Set())
      })
      .catch(() => live && setStale(true))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the scope (group, category) changes only
  }, [group, category])

  /** After a post, poll every few seconds until the indexer has caught up (or a minute passes). */
  const [eager, setEager] = useState(0)
  const onPosted = useCallback((event: ActivityEvent) => {
    setEvents(current => [event, ...current])
    setFresh(new Set([event.id]))
    setEager(Date.now() + 90_000)
  }, [])

  useEffect(() => {
    const tick = async () => {
      if (document.visibilityState === 'hidden') return
      try {
        const page = await fetchPage(0, group, category)
        setEvents(current => {
          const known = new Set(current.map(event => event.id))
          const arrived = page.events.filter(event => !known.has(event.id)).map(event => event.id)
          if (arrived.length) setFresh(new Set(arrived))
          const next = merge(current, page.events, true)
          if (!next.some(event => event.id.startsWith('pending:'))) setEager(0)
          return next
        })
        setNow(page.fetchedAt)
        setStale(false)
      } catch {
        setStale(true)
      }
    }
    const timer = setInterval(tick, eager > Date.now() ? 3_000 : POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [group, category, eager])

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return
    setLoading(true)
    try {
      const page = await fetchPage(events.length, group, category)
      setEvents(current => merge(current, page.events, false))
      setHasMore(page.hasMore)
    } catch {
      setHasMore(false)
    } finally {
      setLoading(false)
    }
  }, [events.length, hasMore, loading, group, category])

  useEffect(() => {
    const marker = markerRef.current
    if (!marker || !hasMore || loading) return
    const observer = new IntersectionObserver(
      entries => entries.some(entry => entry.isIntersecting) && loadMore(),
      { rootMargin: '600px 0px' },
    )
    observer.observe(marker)
    return () => observer.disconnect()
  }, [hasMore, loadMore, loading])

  const groups = groupSameTxEvents(events)

  return (
    <>
      <header className="sticky top-0 z-10 bg-farina/85 px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-4 backdrop-blur-md">
        <div className="flex items-center justify-between">
          <h1 aria-label="succulent" className="flex items-center font-display text-[2.125rem] leading-none tracking-[-0.02em] text-pine">
            {/* A 2.5rem box so its center is known: header padding 1rem + 1.25rem. The stem is at 3.5rem, so the
                slide is exactly 1.25rem. The outer span slides, the inner one gulps, so the transforms don't fight. */}
            <span aria-hidden className="melon-slide inline-flex size-10 items-center justify-center">
              <span className="melon inline-block text-[2.5rem] leading-none">🍉</span>
            </span>
            {/* Shown for a beat on load, then eaten one letter at a time, left to right, as the melon arrives. */}
            <span aria-hidden className="wordmark ml-2 inline-flex whitespace-nowrap">
              {[...'succulent'].map((letter, index) => (
                <span key={index} className="letter inline-block overflow-hidden" style={{ '--i': index } as React.CSSProperties}>
                  {letter}
                </span>
              ))}
            </span>
          </h1>
          <Compose onPosted={onPosted} />
        </div>
      </header>

      <div className="flex items-center justify-between gap-3 px-4 pb-1 pt-1">
        {pinned ? (
          <span className="flex min-w-0 items-center gap-2 border border-bloom py-1 pl-1 pr-1.5 font-mono text-[11px] text-stem">
            <span className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-farina-deep font-display text-[10px] text-pine">
              {projectLogoUrl(pinned.logoUri) ? (
                // eslint-disable-next-line @next/next/no-img-element -- untrusted remote logo
                <img src={projectLogoUrl(pinned.logoUri)!} alt="" className="size-full object-cover" />
              ) : (
                pinned.name[0]?.toUpperCase()
              )}
            </span>
            <span className="truncate text-pine">{pinned.name}</span>
            <button type="button" onClick={() => setPinned(null)} aria-label="Show every page" className="px-1 text-stem hover:text-rose">
              ×
            </button>
          </span>
        ) : (
          <span />
        )}
        {/* The same category filter juicebox.money's project page has, top right of the list. */}
        <span className="relative inline-block shrink-0">
          <span aria-hidden className="select-caret block whitespace-pre pl-[2px] pr-4 font-mono text-[11px] text-stem [background-position:right_2px_center]">
            {category ? ACTIVITY_FILTERS.find(([key]) => key === category)?.[1] : 'All activity'}
          </span>
          <select
            aria-label="Filter activity"
            value={category ?? ''}
            onChange={event => setCategory((event.target.value || null) as ActivityFilter | null)}
            className="absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none border-0 bg-transparent p-0 font-mono text-[11px] text-transparent focus:outline-none [&>option]:text-pine"
          >
            <option value="">All activity</option>
            {ACTIVITY_FILTERS.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </span>
      </div>

      {stale ? (
        <p className="mx-4 mb-2 border border-rose/40 px-3 py-2 font-mono text-[11px] text-rose">
          Connection paused. Retrying every 15 seconds.
        </p>
      ) : null}

      {groups.length === 0 ? (
        <p className="px-4 py-24 text-center text-sm text-stem">
          {loading
            ? 'Loading'
            : category || pinned
              ? 'Nothing here yet for this filter.'
              : 'Nothing has landed yet. New activity shows here within seconds.'}
        </p>
      ) : (
        <ol className="pb-16 pt-2">
          {groups.map(group => (
            <Row key={group[0].id} group={group} now={now} fresh={fresh.has(group[0].id)} onPin={setPinned} />
          ))}
          {hasMore || loading ? (
            <li ref={markerRef} aria-live="polite" className="grid grid-cols-[3.5rem_1fr]">
              <span />
              <span className="flex h-16 items-center border-l border-bloom pl-4 font-mono text-[11px] text-stem-light">
                {loading ? 'loading' : 'older'}
              </span>
            </li>
          ) : null}
        </ol>
      )}
    </>
  )
}

function signedAmount(
  event: ActivityEvent,
  amountUsd: string | null | undefined,
  amountRaw: string | null | undefined,
): string | null {
  try {
    if (amountUsd && BigInt(amountUsd) > 0n) return formatUsd18(amountUsd)
    const project = event.project
    if (amountRaw && project?.tokenSymbol && project.decimals !== null && BigInt(amountRaw) > 0n) {
      return `${formatTokenAmount(amountRaw, project.decimals)} ${project.tokenSymbol.replace(/^\$+/, '')}`
    }
  } catch {
    // Unparseable amount: show none.
  }
  return null
}

function Row({
  group,
  now,
  fresh,
  onPin,
}: {
  group: ActivityEvent[]
  now: number
  fresh: boolean
  onPin: (pinned: PinnedPage | null) => void
}) {
  const event = group[0]
  const name = event.project?.name?.trim() || `Project ${event.projectId}`
  const { actor, action, direction, memo, amountUsd, amountRaw } = combinedActivityParts(group)
  const amount = signedAmount(event, amountUsd, amountRaw)
  const relative = timeAgo(event.timestamp, now)
  const actorHref = addressUrl(event.chainId, actor)
  const txHref = txUrl(event.chainId, event.txHash)
  const project = projectUrl(event.chainId, event.projectId)
  // Tapping the page pins the feed to it; pages without a sucker group fall back to their juicebox.money link.
  const pin = event.suckerGroupId
    ? () =>
        onPin({
          group: event.suckerGroupId!,
          name,
          logoUri: event.project?.logoUri ?? null,
          handle: event.project?.handle ?? null,
          chainId: event.chainId,
          projectId: event.projectId,
        })
    : null

  return (
    <li className={`grid grid-cols-[3.5rem_1fr] ${fresh ? 'animate-bloom' : ''}`}>
      <time
        dateTime={new Date(event.timestamp * 1000).toISOString()}
        title={formatDate(event.timestamp)}
        className="pr-3 pt-4 text-right font-mono text-[11px] leading-none text-stem"
      >
        {relative}
      </time>
      <div className="relative border-l border-bloom py-3.5 pl-4 pr-4">
        {/* The leaf node on the stem. */}
        <span aria-hidden className="absolute -left-[3.5px] top-[1.15rem] size-1.5 rounded-full bg-pine" />
        <div className="flex items-center gap-2.5">
          {pin ? (
            <>
              {/* One hover state for both: the name underlines and the logo lifts, whichever is under the pointer. */}
              <span className="group/page flex min-w-0 flex-1 items-center gap-2.5">
                <button type="button" onClick={pin} aria-label={`Only ${name}`} className="shrink-0 transition-transform group-hover/page:scale-105">
                  <Logo name={name} logoUri={event.project?.logoUri ?? null} />
                </button>
                <button
                  type="button"
                  onClick={pin}
                  className="min-w-0 flex-1 truncate text-left text-[15px] font-medium leading-tight text-pine underline-offset-[3px] decoration-bloom group-hover/page:underline group-hover/page:decoration-stem"
                >
                  {name}
                </button>
              </span>
            </>
          ) : (
            <>
              <span className="group/page flex min-w-0 flex-1 items-center gap-2.5">
                <a href={project} aria-label={`Open ${name} on juicebox.money`} className="shrink-0 transition-transform group-hover/page:scale-105">
                  <Logo name={name} logoUri={event.project?.logoUri ?? null} />
                </a>
                <a href={project} className="min-w-0 flex-1 truncate text-[15px] font-medium leading-tight text-pine underline-offset-[3px] decoration-bloom group-hover/page:underline group-hover/page:decoration-stem">
                  {name}
                </a>
              </span>
            </>
          )}
          <a
            href={txHref ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`View transaction on ${chainName(event.chainId)}`}
            className="shrink-0 font-mono text-[11px] text-stem-light hover:opacity-70"
          >
            {chainIcon(event.chainId) ? (
              // eslint-disable-next-line @next/next/no-img-element -- static local svg
              <img src={chainIcon(event.chainId)!} alt="" width={16} height={16} className="rounded-full" />
            ) : (
              chainSlug(event.chainId)
            )}
          </a>
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-stem">
          {actorHref ? (
            <a href={actorHref} target="_blank" rel="noopener noreferrer" title={actor} className="font-mono text-[12px] text-pine underline decoration-bloom underline-offset-2">
              {truncateAddress(actor)}
            </a>
          ) : (
            <span title={actor} className="font-mono text-[12px] text-pine">{truncateAddress(actor)}</span>
          )}{' '}
          {action}
        </p>
        {memo ? <p className="mt-1.5 break-words text-[13px] leading-relaxed text-pine">“{memo}”</p> : null}
        {amount ? (
          <p
            className={`mt-2 font-mono text-sm font-medium ${
              direction === 'in' ? 'text-moss' : direction === 'out' ? 'text-rose' : 'text-pine'
            }`}
          >
            {direction === 'in' ? '+' : direction === 'out' ? '−' : ''}
            {amount}
          </p>
        ) : null}
      </div>
    </li>
  )
}

function Logo({ name, logoUri }: { name: string; logoUri: string | null }) {
  const src = projectLogoUrl(logoUri)
  const [failed, setFailed] = useState(false)
  return (
    <span
      aria-hidden
      className="relative flex size-8 items-center justify-center overflow-hidden rounded-full bg-farina-deep font-display text-[13px] text-pine"
    >
      {name[0].toUpperCase()}
      {src && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- untrusted remote logo, no optimizer
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="absolute inset-0 size-full object-cover" />
      ) : null}
    </span>
  )
}
