'use client'

import { isAddress, type Address, type Hex } from 'viem'
import type { LaunchedPage, PageRecipient } from './tx'
import type { ChainPayment, RelayrQuote, SignedRelayrEntry } from './relayr'
import { supportsRelayrChains } from './relayr'
import type { PageChainId } from './wagmi'

const KEY = 'succulent:page-launch:v1'

export type PageLaunchSession = {
  version: 1
  id: Hex
  owner: Address
  name: string
  projectUri: string
  logoUri?: string
  chainIds: PageChainId[]
  recipients: PageRecipient[]
  mustStartAtOrAfter: number
  fees: Record<number, string>
  transport: 'direct' | 'relayr'
  signed: SignedRelayrEntry[]
  quote?: RelayrQuote
  previousQuotes?: RelayrQuote[]
  payment?: ChainPayment
  paymentHash?: Hex
  failedPayments?: { chainId: number; hash: Hex }[]
  candidates?: Partial<Record<PageChainId, Hex[]>>
  phase: 'prepared' | 'signing' | 'quoting' | 'quoted' | 'payment-sending' | 'submitted' | 'executing' | 'complete'
  direct: Partial<Record<PageChainId, { phase: 'sending' | 'submitted' | 'complete'; hash?: Hex; safeProposal?: Hex }>>
  launched: LaunchedPage[]
}

/** Storage failure is a stop condition before any signature or wallet submission. */
export function savePageLaunch(session: PageLaunchSession): void {
  const serialized = JSON.stringify(session)
  localStorage.setItem(KEY, serialized)
  if (localStorage.getItem(KEY) !== serialized) throw new Error('The launch could not be saved. Enable browser storage before continuing.')
}

export function loadPageLaunch(): PageLaunchSession | null {
  const raw = localStorage.getItem(KEY)
  if (!raw) return null
  try {
    const session = JSON.parse(raw) as PageLaunchSession
    if (session.version !== 1 || !/^0x[0-9a-fA-F]{64}$/.test(session.id) || !isAddress(session.owner) ||
        !supportsRelayrChains(session.chainIds) || !['direct', 'relayr'].includes(session.transport) ||
        !['prepared', 'signing', 'quoting', 'quoted', 'payment-sending', 'submitted', 'executing', 'complete'].includes(session.phase) ||
        !Array.isArray(session.signed) || !Array.isArray(session.recipients) || !Array.isArray(session.launched) ||
        !session.direct || !session.fees || typeof session.name !== 'string' || typeof session.projectUri !== 'string' ||
        !Number.isSafeInteger(session.mustStartAtOrAfter) || session.chainIds.some(id => !/^\d+$/.test(session.fees[id]))) {
      throw new Error('invalid')
    }
    return session
  } catch {
    throw new Error('The saved launch could not be read. Keep this browser’s launch record; do not submit another launch while its outcome is unknown.')
  }
}

export async function clearPageLaunch(session: PageLaunchSession): Promise<void> {
  return withPageLaunchLock(async () => {
    const saved = loadPageLaunch()
    if (!saved) return
    if (saved.id !== session.id) throw new Error('The saved launch changed. Reload before continuing.')
    if (saved.phase !== 'complete' && (saved.signed.length || Object.keys(saved.direct).length || saved.payment)) {
      throw new Error('Resume this launch before starting another. Its saved authorizations or wallet submission may still execute.')
    }
    localStorage.removeItem(KEY)
  })
}

let running = false
/** One browser-wide journal and an exclusive Web Lock close the duplicate-tab send window. */
export async function withPageLaunchLock<T>(run: () => Promise<T>): Promise<T> {
  if (running) throw new Error('This launch is already running.')
  if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('This browser cannot coordinate launch recovery across tabs. Use a browser with Web Locks support.')
  running = true
  try {
    return await navigator.locks.request('succulent-page-launch', { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('This launch is running in another tab.')
      return run()
    })
  } finally {
    running = false
  }
}
