'use client'

import { useEffect, useRef, useState } from 'react'
import { isAddress, parseUnits, type Address } from 'viem'
import { normalize } from 'viem/ens'
import { getEnsAddress, getPublicClient } from 'wagmi/actions'
import { wagmiConfig } from '@/lib/wagmi'
import { payOptionsFor, type PayOption } from '@/lib/pay-options'
import { useAccount } from 'wagmi'
import type { PageRef } from '@/lib/bendystraw'
import { CHAINS, type PageChainId } from '@/lib/wagmi'
import { chainIcon, chainName, chainSlug, txUrl } from '@/lib/chains'
import { projectLogoUrl } from '@/lib/format'
import { createPage, destinationExistsOn, destinationLabel, destinationOn, failureReason, postToPage, recipientsProblem, type Destination, type LaunchedPage, type PageRecipient } from '@/lib/tx'
import { Sheet } from './Sheet'
import { X } from '@/components/ui/icons'
import { SignIn, SignedInAs } from './SignIn'
import { useParaAuth } from '@/providers/ParaAuthContext'

/** Focus the first field on open only where a keyboard is already there; on touch devices it would zoom and cover the sheet. */
const AUTO_FOCUS = typeof window !== 'undefined' && !window.matchMedia('(pointer: coarse)').matches

const field =
  'w-full border border-bloom bg-white/60 px-3 py-2.5 text-base text-pine placeholder:text-stem-light focus:border-moss focus:outline-none'
const primary =
  'w-full bg-pine px-4 py-3 text-[15px] font-medium text-farina disabled:opacity-40'

function PageRow({ page, onPick }: { page: PageRef; onPick: (page: PageRef) => void }) {
  const src = projectLogoUrl(page.logoUri)
  return (
    <li>
      <button type="button" onClick={() => onPick(page)} className="flex w-full items-center gap-2.5 py-2 text-left hover:bg-farina-deep/60">
        <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-farina-deep font-display text-[12px]">
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element -- untrusted remote logo
            <img src={src} alt="" className="size-full object-cover" />
          ) : (
            (page.name ?? '?')[0]?.toUpperCase()
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-[15px]">{page.name?.trim() || `Page ${page.projectId}`}</span>
        <span className="flex items-center">
          {[...page.peers]
            .sort((a, b) => a.chainId - b.chainId)
            .map((peer, index) => (
              <span key={peer.chainId} className={index ? '-ml-1' : ''} title={chainName(peer.chainId)}>
                {chainIcon(peer.chainId) ? (
                  // eslint-disable-next-line @next/next/no-img-element -- static local svg
                  <img src={chainIcon(peer.chainId)!} alt={chainName(peer.chainId)} width={14} height={14} className="rounded-full ring-1 ring-farina" />
                ) : (
                  <span className="font-mono text-[11px] text-stem-light">{chainSlug(peer.chainId)}</span>
                )}
              </span>
            ))}
        </span>
      </button>
    </li>
  )
}

function PagePicker({
  owner,
  onPick,
  onAddress,
  chainId,
  compact = false,
}: {
  owner: string | undefined
  onPick: (page: PageRef) => void
  /** When set, a pasted 0x address or an ENS name is offered as a recipient instead of searched for. */
  onAddress?: (address: Address, ens?: string) => void
  /** Only pages deployed on this chain. */
  chainId?: number
  /** Shorter results box for pickers nested inside a form row. */
  compact?: boolean
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ mine: PageRef[]; found: PageRef[] } | null>(null)
  const [ens, setEns] = useState<{ name: string; address: Address | null } | 'pending' | null>(null)
  const ensName = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i.test(query.trim()) ? query.trim().toLowerCase() : null

  // ENS names resolve on mainnet whichever network the split lands on.
  useEffect(() => {
    if (!onAddress || !ensName) {
      setEns(null)
      return
    }
    let live = true
    setEns('pending')
    const timer = setTimeout(async () => {
      try {
        const address = await getEnsAddress(wagmiConfig, { name: normalize(ensName), chainId: 1 })
        if (live) setEns({ name: ensName, address })
      } catch {
        if (live) setEns({ name: ensName, address: null })
      }
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [ensName, onAddress])

  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query })
        if (owner) params.set('owner', owner)
        const response = await fetch(`/api/pages?${params}`, { signal: controller.signal })
        if (response.ok) {
          const page = (await response.json()) as { mine: PageRef[]; found: PageRef[] }
          const on = (list: PageRef[]) => (chainId ? list.filter(entry => entry.peers.some(peer => peer.chainId === chainId)) : list)
          setResults({ mine: on(page.mine), found: on(page.found) })
        }
      } catch {
        // Aborted or offline: keep what we have.
      }
    }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, owner, chainId])

  return (
    <div className="space-y-3">
      <input
        className={field}
        placeholder={onAddress ? 'Page name, ENS, or 0x address' : 'Find a page'}
        value={query}
        onChange={event => setQuery(event.target.value)}
        autoFocus={AUTO_FOCUS}
      />
      {onAddress && ensName ? (
        ens === 'pending' || ens === null ? (
          <p className="px-3 py-2.5 font-mono text-[11px] text-stem-light">resolving {ensName}</p>
        ) : ens.address ? (
          <button
            type="button"
            onClick={() => onAddress(ens.address!, ens.name)}
            className="flex w-full items-center justify-between gap-2 border border-bloom px-3 py-2.5 text-left text-[14px] hover:bg-farina-deep/60"
          >
            <span className="min-w-0 truncate">
              {ens.name} <span className="font-mono text-[12px] text-stem">{`${ens.address.slice(0, 6)}…${ens.address.slice(-4)}`}</span>
            </span>
            <span className="shrink-0 font-mono text-[11px] text-stem">add address</span>
          </button>
        ) : (
          <p className="px-3 py-2.5 font-mono text-[11px] text-rose">{ens.name} has no address set</p>
        )
      ) : null}
      {onAddress && isAddress(query.trim()) ? (
        <button
          type="button"
          onClick={() => onAddress(query.trim() as Address)}
          className="flex w-full items-center justify-between gap-2 border border-bloom px-3 py-2.5 text-left text-[14px] hover:bg-farina-deep/60"
        >
          <span className="font-mono text-[13px]">{`${query.trim().slice(0, 6)}…${query.trim().slice(-4)}`}</span>
          <span className="font-mono text-[11px] text-stem">add address</span>
        </button>
      ) : null}
      {/* Fixed height so the sheet lays out once, on open, instead of jumping when results land.
          Hidden while the field holds an ENS name or address: the resolved row above is the answer. */}
      <div className={`${compact ? 'h-[24svh]' : 'h-[40svh]'} overflow-y-auto ${onAddress && (ensName || isAddress(query.trim())) ? 'hidden' : ''}`}>
        {results === null ? (
          <ul aria-hidden className="divide-y divide-bloom">
            {Array.from({ length: compact ? 4 : 7 }, (_, i) => (
              <li key={i} className="flex items-center gap-2.5 py-2">
                <span className="size-7 shrink-0 animate-pulse rounded-full bg-farina-deep" />
                <span className="h-3.5 flex-1 animate-pulse rounded-sm bg-farina-deep" style={{ maxWidth: `${[62, 44, 70, 52, 58, 40, 66][i % 7]}%` }} />
                <span className="size-3.5 shrink-0 animate-pulse rounded-full bg-farina-deep" />
              </li>
            ))}
          </ul>
        ) : null}
        {results?.mine.length ? (
          <>
            <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-stem">your pages</p>
            <ul className="mb-3 divide-y divide-bloom">{results.mine.map(page => <PageRow key={`${page.chainId}:${page.projectId}`} page={page} onPick={onPick} />)}</ul>
          </>
        ) : null}
        {results?.found.length ? (
          <ul className="divide-y divide-bloom">{results.found.filter(page => !results.mine.some(mine => mine.chainId === page.chainId && mine.projectId === page.projectId)).map(page => <PageRow key={`${page.chainId}:${page.projectId}`} page={page} onPick={onPick} />)}</ul>
        ) : results && query && !ensName && !isAddress(query.trim()) ? (
          <p className="py-6 text-center text-[13px] text-stem">No page matches “{query}”.</p>
        ) : null}
      </div>
    </div>
  )
}

const small = 'border border-bloom bg-white/60 px-2 py-1 font-mono text-[12px] text-pine focus:border-moss focus:outline-none'

/** One address or ENS name, resolved as you type; empty falls back to the split's default. */
function InlineAddress({
  initial,
  disabled,
  onCommit,
}: {
  initial: Destination
  disabled: boolean
  onCommit: (destination: { kind: 'address'; address: Address; ens?: string } | undefined) => void
}) {
  const [text, setText] = useState(initial.kind === 'address' ? initial.address : '')
  const [state, setState] = useState<'ok' | 'pending' | 'bad'>('ok')
  useEffect(() => {
    const value = text.trim()
    if (!value) {
      setState('ok')
      onCommit(undefined)
      return
    }
    if (isAddress(value)) {
      setState('ok')
      onCommit({ kind: 'address', address: value })
      return
    }
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i.test(value)) {
      setState('bad')
      return
    }
    let live = true
    setState('pending')
    const timer = setTimeout(async () => {
      try {
        const address = await getEnsAddress(wagmiConfig, { name: normalize(value.toLowerCase()), chainId: 1 })
        if (!live) return
        if (address) {
          setState('ok')
          onCommit({ kind: 'address', address, ens: value.toLowerCase() })
          setText(address)
        } else setState('bad')
      } catch {
        if (live) setState('bad')
      }
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // onCommit is stable enough per row; re-running on identity changes would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])
  return (
    <input
      value={text}
      disabled={disabled}
      onChange={event => setText(event.target.value)}
      placeholder="0x… or name.eth"
      spellCheck={false}
      className={`${small} min-w-0 flex-1 ${state === 'bad' ? 'border-rose' : state === 'pending' ? 'border-stem-light' : ''}`}
    />
  )
}

function Recipients({
  recipients,
  chainIds,
  owner,
  disabled,
  onChange,
}: {
  recipients: PageRecipient[]
  chainIds: PageChainId[]
  owner: string | undefined
  disabled: boolean
  onChange: (next: PageRecipient[]) => void
}) {
  const [adding, setAdding] = useState(false)
  /** Explicit open/closed per split; unset falls back to "open when the page is only on some networks". */
  const [perChainOpen, setPerChainOpen] = useState<Record<number, boolean>>({})

  const update = (index: number, patch: Partial<PageRecipient>) =>
    onChange(recipients.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)))
  const remove = (index: number) => onChange(recipients.filter((_, i) => i !== index))
  const add = (destination: Destination) => {
    onChange([...recipients, { percent: 10, destination }])
    setAdding(false)
  }
  // What the owner keeps per network: splits with no destination there stay with the owner.
  const keep = chainIds.map(chainId => ({
    chainId,
    percent: 100 - recipients.reduce((sum, entry) => sum + (destinationOn(entry, chainId).kind === 'none' ? 0 : entry.percent), 0),
  }))
  const sameEverywhere = new Set(keep.map(entry => entry.percent)).size <= 1

  return (
    <fieldset className="space-y-2">
      <legend className="mb-1.5 font-mono text-[11px] text-stem">Split earnings with</legend>
      {recipients.length ? (
        <ul className="divide-y divide-bloom border border-bloom">
          {recipients.map((recipient, index) => {
            // A page not deployed everywhere opens the per-network rows so the "no split" defaults are visible.
            const partial = recipient.destination.kind === 'page' && chainIds.some(chainId => !destinationExistsOn(recipient.destination, chainId))
            const open = perChainOpen[index] ?? false
            return (
              <li key={index} className="space-y-1 px-2.5 py-2">
                <div className="flex items-center gap-2">
                  {recipient.destination.kind === 'page' ? (
                    <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-farina-deep font-display text-[11px]">
                      {projectLogoUrl(recipient.destination.page.logoUri) ? (
                        // eslint-disable-next-line @next/next/no-img-element -- untrusted remote logo
                        <img src={projectLogoUrl(recipient.destination.page.logoUri)!} alt="" className="size-full object-cover" />
                      ) : (
                        (recipient.destination.page.name ?? '?')[0]?.toUpperCase()
                      )}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-[14px]" title={recipient.destination.kind === 'address' ? recipient.destination.address : undefined}>
                    {destinationLabel(recipient.destination)}
                  </span>
                  <span className="flex items-center gap-1">
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      max={100}
                      step={0.5}
                      value={recipient.percent}
                      disabled={disabled}
                      onChange={event => update(index, { percent: Math.max(0, Math.min(100, Number(event.target.value) || 0)) })}
                      className={`${small} w-16 text-right pointer-coarse:w-20`}
                    />
                    <span className="font-mono text-[12px] text-stem">%</span>
                  </span>
                  <button type="button" onClick={() => remove(index)} disabled={disabled} aria-label="Remove" className="px-1 font-mono text-[12px] text-stem hover:text-rose">
                    ×
                  </button>
                </div>
                {recipient.destination.kind === 'page' && chainIds.length > 1 ? (
                  <>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => setPerChainOpen(current => ({ ...current, [index]: !open }))}
                      className="flex items-center gap-1.5 font-mono text-[11px] text-stem underline-offset-2 hover:underline"
                    >
                      {partial ? 'only on' : 'on'}
                      <span className="flex items-center">
                        {chainIds
                          .filter(chainId => destinationOn(recipient, chainId).kind !== 'none')
                          .map((chainId, i) => (
                            // eslint-disable-next-line @next/next/no-img-element -- static local svg
                            <img key={chainId} src={chainIcon(chainId)!} alt={chainName(chainId)} width={14} height={14} className={`rounded-full ring-1 ring-farina ${i ? '-ml-1' : ''}`} />
                          ))}
                      </span>
                    </button>
                    {open ? (
                      <div className="flex flex-wrap gap-1.5 pl-3">
                        {/* Only networks the page is deployed on can carry the split; toggling one off keeps that share with the owner. */}
                        {chainIds
                          .filter(chainId => destinationExistsOn(recipient.destination, chainId))
                          .map(chainId => {
                            const on = destinationOn(recipient, chainId).kind !== 'none'
                            return (
                              <label
                                key={chainId}
                                title={chainName(chainId)}
                                className={`flex size-8 cursor-pointer select-none items-center justify-center border transition-opacity ${on ? 'border-pine bg-white/60' : 'border-bloom opacity-35 grayscale'}`}
                              >
                                <input
                                  type="checkbox"
                                  className="sr-only"
                                  checked={on}
                                  disabled={disabled}
                                  aria-label={chainName(chainId)}
                                  onChange={() => {
                                    const perChain = { ...recipient.perChain }
                                    if (on) perChain[chainId] = { kind: 'none' }
                                    else delete perChain[chainId]
                                    update(index, { perChain })
                                  }}
                                />
                                {/* eslint-disable-next-line @next/next/no-img-element -- static local svg */}
                                <img src={chainIcon(chainId)!} alt="" width={18} height={18} className="rounded-full" />
                              </label>
                            )
                          })}
                      </div>
                    ) : null}
                  </>
                ) : null}
                {open && recipient.destination.kind === 'address'
                  ? chainIds.map(chainId => (
                      <div key={chainId} className="flex items-center gap-2">
                        {/* eslint-disable-next-line @next/next/no-img-element -- static local svg */}
                        <img src={chainIcon(chainId)!} alt={chainName(chainId)} title={chainName(chainId)} width={16} height={16} className="shrink-0 rounded-full" />
                        <InlineAddress
                          key={`${index}:${chainId}`}
                          initial={destinationOn(recipient, chainId)}
                          disabled={disabled}
                          onCommit={destination => {
                            const perChain = { ...recipient.perChain }
                            if (destination) perChain[chainId] = destination
                            else delete perChain[chainId]
                            update(index, { perChain })
                          }}
                        />
                      </div>
                    ))
                  : null}
                {/* A page already resolves per network through its sucker group; only a bare address can want a
                    different recipient per network. */}
                {chainIds.length > 1 && recipient.destination.kind === 'address' ? (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setPerChainOpen(current => ({ ...current, [index]: !open }))}
                    className="font-mono text-[11px] text-stem underline-offset-2 hover:underline"
                  >
                    {open ? 'Hide' : 'set destination per network'}
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
      {adding ? (
        <PagePicker
          owner={owner}
          onPick={page => add({ kind: 'page', page })}
          onAddress={(address, ens) => add({ kind: 'address', address, ens })}
        />
      ) : null}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setAdding(current => !current)}
        aria-label={adding ? 'Cancel' : undefined}
        className="inline-flex items-center border border-bloom px-2.5 py-1.5 font-mono text-[12px] text-pine hover:border-stem"
      >
        {adding ? <X aria-hidden className="h-3.5 w-3.5" /> : '+ Add split'}
      </button>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-stem">
        <span>{recipients.length ? 'You keep' : 'Right now, you keep'}</span>
        {sameEverywhere ? (
          <span>{keep[0]?.percent ?? 100}%</span>
        ) : (
          keep.map(entry => (
            <span key={entry.chainId} className="flex items-center gap-1" title={chainName(entry.chainId)}>
              {/* eslint-disable-next-line @next/next/no-img-element -- static local svg */}
              <img src={chainIcon(entry.chainId)!} alt={chainName(entry.chainId)} width={12} height={12} className="rounded-full" />
              {entry.percent}%
            </span>
          ))
        )}
      </p>
    </fieldset>
  )
}

function CreatePage({ owner, onCreated, onSignIn }: { owner: `0x${string}` | undefined; onCreated: (page: PageRef) => void; onSignIn: () => void }) {
  const { chain } = useAccount()
  const [name, setName] = useState('')
  const [logo, setLogo] = useState<File | null>(null)
  const [chainIds, setChainIds] = useState<PageChainId[]>(CHAINS.map(c => c.id))
  const [recipients, setRecipients] = useState<PageRecipient[]>([])
  const [step, setStep] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [launched, setLaunched] = useState<LaunchedPage[]>([])
  const toggleChain = (id: PageChainId) =>
    setChainIds(current => (current.includes(id) ? current.filter(entry => entry !== id) : [...current, id]))
  const preview = logo ? URL.createObjectURL(logo) : null
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])
  const problem = recipientsProblem(recipients)

  const submit = async () => {
    if (!owner) return
    setError(null)
    setLaunched([])
    try {
      // Launch on the wallet's current chain first so the first confirmation needs no switch.
      const ordered = [...chainIds].sort((a, b) => Number(b === chain?.id) - Number(a === chain?.id))
      const pages = await createPage({
        chainIds: ordered,
        name: name.trim(),
        logo,
        owner,
        recipients,
        onStep: setStep,
        onLaunched: page => setLaunched(current => [...current, page]),
      })
      onCreated({
        chainId: pages[0].chainId,
        projectId: pages[0].projectId,
        name: name.trim(),
        logoUri: null,
        peers: pages.map(page => ({ chainId: page.chainId, projectId: page.projectId })),
      })
    } catch (caught) {
      setError(failureReason(caught))
    } finally {
      setStep(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <label className="flex size-14 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-dashed border-stem-light bg-white/40 font-mono text-[10px] text-stem">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element -- local file preview
            <img src={preview} alt="" className="size-full object-cover" />
          ) : (
            'logo'
          )}
          <input type="file" accept="image/*" className="sr-only" onChange={event => setLogo(event.target.files?.[0] ?? null)} />
        </label>
        <input className={`${field} font-display text-xl`} placeholder="Page name" value={name} maxLength={80} onChange={event => setName(event.target.value)} autoFocus={AUTO_FOCUS} />
      </div>
      <fieldset>
        <legend className="mb-1.5 font-mono text-[11px] text-stem">Receive paid posts on</legend>
        <div className="flex flex-wrap gap-1.5">
          {CHAINS.map(c => {
            const on = chainIds.includes(c.id)
            return (
              <label
                key={c.id}
                title={chainName(c.id)}
                className={`flex size-10 cursor-pointer select-none items-center justify-center border transition-opacity ${on ? 'border-pine bg-white/60' : 'border-bloom opacity-35 grayscale'}`}
              >
                <input type="checkbox" className="sr-only" checked={on} onChange={() => toggleChain(c.id)} disabled={step !== null} aria-label={chainName(c.id)} />
                {/* eslint-disable-next-line @next/next/no-img-element -- static local svg */}
                <img src={chainIcon(c.id)!} alt="" width={22} height={22} className="rounded-full" />
              </label>
            )
          })}
        </div>
      </fieldset>
      <Recipients recipients={recipients} chainIds={chainIds} owner={owner} disabled={step !== null} onChange={setRecipients} />
      {problem ? <p className="text-[13px] text-rose">{problem}</p> : null}
      {launched.length ? (
        <p className="font-mono text-[11px] text-moss">
          live on {launched.map(page => chainName(page.chainId)).join(', ')}
        </p>
      ) : null}
      {owner ? (
        <button type="button" className={primary} disabled={!name.trim() || !chainIds.length || !!problem || step !== null} onClick={submit}>
          {step ?? (chainIds.length > 1 ? `Create page on ${chainIds.length} networks` : 'Create page')}
        </button>
      ) : (
        <SignIn onOpen={onSignIn} />
      )}
      {error ? <p className="text-[13px] text-rose">{error}</p> : null}
    </div>
  )
}

export function Compose() {
  const { address, isConnected, chain } = useAccount()
  const [sheet, setSheet] = useState<'none' | 'post' | 'create'>('none')
  // Sign-in replaces the sheet rather than stacking on it: remember which sheet to bring back once
  // Para's sheet has opened and closed. State inside the sheets survives because they stay mounted.
  const { modalOpen: paraOpen } = useParaAuth()
  const [resume, setResume] = useState<'post' | 'create' | null>(null)
  const sawParaOpen = useRef(false)
  const stepAside = () => {
    setResume(sheet === 'none' ? null : sheet)
    sawParaOpen.current = false
    setSheet('none')
  }
  useEffect(() => {
    if (!resume) return
    if (paraOpen) {
      sawParaOpen.current = true
      return
    }
    if (sawParaOpen.current) {
      setSheet(resume)
      setResume(null)
    }
  }, [paraOpen, resume])
  /** A collapsed page lives on several chains; post on the wallet's chain when it is one of them. */
  const pick = (page: PageRef) => {
    const local = page.peers.find(peer => peer.chainId === chain?.id)
    setPage(local ? { ...page, chainId: local.chainId, projectId: local.projectId } : page)
  }
  const [page, setPage] = useState<PageRef | null>(null)
  const [memo, setMemo] = useState('')
  const [amount, setAmount] = useState('')
  const [options, setOptions] = useState<PayOption[] | null>(null)
  const [option, setOption] = useState<PayOption | null>(null)
  const [step, setStep] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [posted, setPosted] = useState<{ hash: `0x${string}`; chainId: number } | null>(null)

  const close = () => {
    setSheet('none')
    setError(null)
    // The next Post starts at the picker; there is no in-sheet way back to it.
    setPage(null)
  }

  // What this page can be paid in, on its chain: its own accounting tokens first, then the other via the router.
  useEffect(() => {
    setOptions(null)
    setOption(null)
    if (!page) return
    let live = true
    const publicClient = getPublicClient(wagmiConfig, { chainId: page.chainId as PageChainId })
    if (!publicClient) return
    payOptionsFor(publicClient as unknown as Parameters<typeof payOptionsFor>[0], page.chainId as PageChainId, page.projectId)
      .then(found => {
        if (!live) return
        setOptions(found)
        setOption(found[0] ?? null)
      })
      .catch(() => {
        if (!live) return
        // Reads failed: offer ETH direct, the protocol default, rather than nothing.
        const fallback: PayOption = { symbol: 'ETH', token: '0x000000000000000000000000000000000000EEEe', decimals: 18, viaRouter: false }
        setOptions([fallback])
        setOption(fallback)
      })
    return () => {
      live = false
    }
  }, [page])

  let amountWei = 0n
  let amountBad = false
  try {
    amountWei = amount.trim() && option ? parseUnits(amount.trim(), option.decimals) : 0n
  } catch {
    amountBad = true
  }

  const submit = async () => {
    if (!page || !address || !options) return
    setBusy(true)
    setError(null)
    try {
      // A memo-only post pays 0 of a token the page accepts directly; a swap of nothing has nothing to swap.
      const paying = amountWei > 0n && option ? option : options.find(entry => !entry.viaRouter) ?? options[0]
      const hash = await postToPage({
        chainId: page.chainId as PageChainId,
        projectId: page.projectId,
        memo: memo.trim(),
        amount: amountWei > 0n ? amountWei : 0n,
        option: paying,
        account: address,
        onStep: setStep,
      })
      setPosted({ hash, chainId: page.chainId })
      setMemo('')
      setAmount('')
    } catch (caught) {
      setError(failureReason(caught))
    } finally {
      setBusy(false)
      setStep(null)
    }
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setSheet('create')}
          className="inline-flex h-8 items-center border border-pine px-3.5 text-[13px] font-medium text-pine"
        >
          New page
        </button>
        <button
          type="button"
          onClick={() => {
            setPosted(null)
            setSheet('post')
          }}
          className="inline-flex h-8 items-center border border-pine bg-pine px-3.5 text-[13px] font-medium text-farina"
        >
          Post
        </button>
      </div>

      <Sheet open={sheet === 'post'} onClose={close} title={posted ? 'Posted' : page ? `Post to ${page.name?.trim() || `Page ${page.projectId}`}` : 'Post'}>
        {posted ? (
          <div className="space-y-3">
            <p className="text-[13px] text-stem">It will show in the feed once indexed, usually within a minute.</p>
            {txUrl(posted.chainId, posted.hash) ? (
              <a href={txUrl(posted.chainId, posted.hash)!} target="_blank" rel="noopener noreferrer" className="font-mono text-[12px] text-pine underline decoration-bloom underline-offset-2">
                view transaction
              </a>
            ) : null}
            <button type="button" className={primary} onClick={close}>Done</button>
          </div>
        ) : !page ? (
          <PagePicker owner={address} onPick={pick} />
        ) : (
          <div className="space-y-3">
            <p className="flex items-baseline gap-1 font-mono text-[11px] text-stem">
              On
            {page.peers.length > 1 ? (
              // The page lives on several networks: pick where this payment lands; tokens reload for it.
              // An invisible mirror of the selected name sets the cell width, so the select (and its
              // underline) fit the word plus a 6px gap, the 10px chevron, and 2px each side, in any browser.
              <span className="relative inline-block">
                {/* The word and chevron are painted here; the select on top is invisible but does the work, so the
                    spacing is exact in every browser instead of depending on the select's own text inset. */}
                <span aria-hidden className="select-caret block whitespace-pre border-b border-dotted border-stem pl-[2px] pr-4 text-pine [background-position:right_2px_center]">
                  {chainName(page.chainId)}
                </span>
              <select
                aria-label="Network"
                value={page.chainId}
                disabled={busy}
                onChange={event => {
                  const peer = page.peers.find(entry => entry.chainId === Number(event.target.value))
                  if (peer) setPage({ ...page, chainId: peer.chainId, projectId: peer.projectId })
                }}
                className="absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none border-0 bg-transparent p-0 font-mono text-[11px] text-transparent focus:outline-none [&>option]:text-pine"
              >
                {[...page.peers]
                  .sort((a, b) => a.chainId - b.chainId)
                  .map(peer => (
                    <option key={peer.chainId} value={peer.chainId}>
                      {chainName(peer.chainId)}
                    </option>
                  ))}
              </select>
              </span>
            ) : (
              <span className="text-pine">{chainName(page.chainId)}</span>
            )}
            </p>
            <textarea className={`${field} block min-h-28 resize-none`} placeholder="Let ’em know" value={memo} maxLength={280} onChange={event => setMemo(event.target.value)} autoFocus={AUTO_FOCUS} />
            <label className="-mt-1 block">
              <span className="font-mono text-[11px] text-stem">Optionally, add a payment</span>
              <span className="mt-1 flex items-stretch border border-bloom bg-white/60 focus-within:border-moss">
                <input
                  className="min-w-0 flex-1 bg-transparent px-3 py-2.5 font-mono text-base text-pine placeholder:text-stem-light focus:outline-none"
                  inputMode="decimal"
                  placeholder="0"
                  value={amount}
                  disabled={options === null}
                  onChange={event => setAmount(event.target.value)}
                />
                {/* The token lives inside the field, like juicebox.money's pay card. A native select sizes to its
                    longest option, so an invisible mirror of the one showing sets the width instead. */}
                <span className="relative inline-block">
                  <span aria-hidden className={`invisible block whitespace-pre py-2.5 pl-3 font-mono text-[12px] pointer-coarse:text-base ${options && options.length < 2 ? 'pr-3' : 'pr-8'}`}>
                    {option?.symbol ?? 'ETH'}
                  </span>
                <select
                  aria-label="Payment token"
                  value={option ? `${option.symbol}:${option.viaRouter}` : ''}
                  aria-busy={options === null || undefined}
                  disabled={options !== null && options.length < 2}
                  onChange={event => setOption(options?.find(entry => `${entry.symbol}:${entry.viaRouter}` === event.target.value) ?? null)}
                  className={`select-caret absolute inset-0 h-full w-full border-l border-bloom bg-transparent pl-3 pr-8 font-mono text-[12px] focus:outline-none disabled:opacity-100 ${options === null ? 'select-caret-idle text-stem-light' : options.length < 2 ? 'text-pine disabled:pr-3' : 'text-pine'}`}
                >
                  {options === null ? <option value="">ETH</option> : null}
                  {(options ?? []).map(entry => (
                    <option key={`${entry.symbol}:${entry.viaRouter}`} value={`${entry.symbol}:${entry.viaRouter}`}>
                      {entry.symbol}
                    </option>
                  ))}
                </select>
                </span>
              </span>
            </label>
            {isConnected && address ? (
              <>
                <button type="button" className={primary} disabled={busy || amountBad || options === null || (!memo.trim() && amountWei === 0n)} onClick={submit}>
                  {busy ? step ?? 'Confirm in your wallet' : amountWei > 0n ? 'Post and pay' : 'Post'}
                </button>
                <SignedInAs />
              </>
            ) : (
              <SignIn onOpen={stepAside} />
            )}
            {error ? <p className="text-[13px] text-rose">{error}</p> : null}
          </div>
        )}
      </Sheet>

      <Sheet open={sheet === 'create'} onClose={() => setSheet('none')} title="Create a page">
        <CreatePage
          owner={address}
          onSignIn={stepAside}
          onCreated={created => {
            setPage(created)
            setPosted(null)
            setSheet('post')
          }}
        />
      </Sheet>
    </>
  )
}
