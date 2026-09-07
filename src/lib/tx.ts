'use client'

import { JBCoreContracts, NATIVE_TOKEN, erc2771ForwarderAbi, jbContractAddress } from '@bananapus/nana-sdk-core'
import type { PayOption } from './pay-options'
import { createJBCenterClient } from '@bananapus/nana-sdk-core/jbcenter'
import { buildPayTx, getProjectCreationFee, projectIdFromLaunchLogs, resolvePaymentTerminal } from '@bananapus/nana-sdk-core/v6'
import { getAccount, getPublicClient, readContract, sendTransaction, switchChain, waitForTransactionReceipt, writeContract } from 'wagmi/actions'
import { encodeFunctionData, erc20Abi, isAddressEqual, toHex, type Address, type Hex, type Log, type PublicClient } from 'viem'
import { pageLaunchTx, pageOmnichainLaunchTx, type PageSplit } from './page-launch'
import type { PageRef } from './bendystraw'
import { chainName } from './chains'
import { wagmiConfig, type PageChainId } from './wagmi'
import { assertForwardRequestBindings, payQuote, requestQuote, signForwardRequests, verifyForwardRequests, bindQuote, getBundle, bundleHash, paymentOptions, supportsRelayrChains, type ChainPayment, type RelayrCall } from './relayr'
import { loadPageLaunch, savePageLaunch, withPageLaunchLock, type PageLaunchSession } from './page-launch-session'
import { safeExecutionHash, verifySafeLaunch } from './launch-safe'

const center = createJBCenterClient()

function client(chainId: PageChainId): PublicClient {
  const publicClient = getPublicClient(wagmiConfig, { chainId })
  if (!publicClient) throw new Error('This chain is not supported.')
  // OP-stack chains type their transactions with extra formatters; the SDK only needs the generic reads.
  return publicClient as unknown as PublicClient
}

async function onChain(chainId: PageChainId) {
  await switchChain(wagmiConfig, { chainId })
}

/**
 * Post a memo to a Page, optionally with a payment in `option`'s token. A zero-value pay is a
 * valid post. ERC-20 payments approve the terminal first when the allowance is short; payments
 * via the router go to the router registry, which swaps into what the page accepts.
 */
export async function postToPage(args: {
  chainId: PageChainId
  projectId: number
  memo: string
  amount: bigint
  option: PayOption
  account: Address
  onStep?: (step: string) => void
}): Promise<Hex> {
  const { chainId, option } = args
  const projectId = BigInt(args.projectId)
  // JBDirectory decides: the project's primary terminal for this token when it has one (Artizen's ETH
  // terminal is a router terminal it registered itself), else the router registry. Never assume.
  const terminal = (await resolvePaymentTerminal(client(chainId), { chainId, projectId, token: option.token })).address
  await onChain(chainId)
  if (option.token.toLowerCase() !== NATIVE_TOKEN.toLowerCase() && args.amount > 0n) {
    const allowance = await readContract(wagmiConfig, {
      chainId,
      address: option.token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [args.account, terminal],
    })
    if (allowance < args.amount) {
      args.onStep?.(`Approve ${option.symbol} in your wallet`)
      const approval = await writeContract(wagmiConfig, {
        chainId,
        address: option.token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [terminal, args.amount],
      })
      await waitForTransactionReceipt(wagmiConfig, { hash: approval, chainId })
    }
  }
  args.onStep?.('Confirm in your wallet')
  const tx = buildPayTx({
    chainId,
    terminal,
    projectId,
    token: option.token,
    amount: args.amount,
    beneficiary: args.account,
    memo: args.memo,
  })
  const hash = await writeContract(wagmiConfig, { ...tx, chainId })
  await waitForTransactionReceipt(wagmiConfig, { hash, chainId })
  return hash
}

export type LaunchedPage = { chainId: PageChainId; projectId: number; hash: Hex }

/** Where a share of earnings goes: an address, another page (its tokens go to the owner), or nowhere. */
export type Destination = { kind: 'address'; address: Address; ens?: string } | { kind: 'page'; page: PageRef } | { kind: 'none' }

/**
 * Who shares a page's earnings. One percent on every chain; the destination is `destination`
 * everywhere unless `perChain` names another one there (a page recipient only exists on some chains).
 */
export type PageRecipient = { percent: number; destination: Destination; perChain?: Partial<Record<number, Destination>> }

export function destinationLabel(destination: Destination): string {
  if (destination.kind === 'none') return 'no split'
  if (destination.kind === 'address') return destination.ens ?? `${destination.address.slice(0, 6)}…${destination.address.slice(-4)}`
  return destination.page.name?.trim() || `Page ${destination.page.projectId}`
}

/** True when `destination` can receive on `chainId`: any address, or a page deployed there. */
export function destinationExistsOn(destination: Destination, chainId: number): boolean {
  return destination.kind !== 'page' || destination.page.peers.some(peer => peer.chainId === chainId)
}

/**
 * The destination on one chain: the per-chain choice if any, else the default, else no split at
 * all where the default page is not deployed (the owner keeps that share there).
 */
export function destinationOn(recipient: PageRecipient, chainId: number): Destination {
  const chosen = recipient.perChain?.[chainId] ?? recipient.destination
  return destinationExistsOn(chosen, chainId) ? chosen : { kind: 'none' }
}

/** Why `recipients` cannot launch, or null when they can: shares may not exceed 100%. */
export function recipientsProblem(recipients: readonly PageRecipient[]): string | null {
  const total = recipients.reduce((sum, recipient) => sum + recipient.percent, 0)
  if (total > 100) return `Splits add up to ${total}%. Keep them at or under 100%.`
  return null
}

/** The encoded splits for one chain. Throws on the problems `recipientsProblem` reports. */
export function splitsOn(chainId: number, recipients: readonly PageRecipient[], owner: Address): PageSplit[] {
  const problem = recipientsProblem(recipients)
  if (problem) throw new Error(problem)
  const splits: PageSplit[] = []
  for (const recipient of recipients) {
    if (recipient.percent <= 0) continue
    const destination = destinationOn(recipient, chainId)
    if (destination.kind === 'none') continue
    if (destination.kind === 'address') {
      splits.push({ percent: recipient.percent, beneficiary: destination.address, projectId: 0n })
      continue
    }
    const peer = destination.page.peers.find(entry => entry.chainId === chainId)!
    splits.push({ percent: recipient.percent, beneficiary: owner, projectId: BigInt(peer.projectId) })
  }
  return splits
}

/**
 * The project id from a launch receipt, via the SDK (2.4.1+), which decodes LaunchProject or
 * LaunchRulesets from the canonical controller and Create from the canonical JBProjects, so
 * deployer-created (omnichain) launches resolve too.
 */
export function projectIdFromLogs(logs: Log[], chainId: PageChainId): number | null {
  const projectId = projectIdFromLaunchLogs(logs, { chainId })
  return projectId === null ? null : Number(projectId)
}

async function pinPage(args: { name: string; logo: File | null; onStep: (step: string) => void }): Promise<{ projectUri: string; logoUri?: string }> {
  args.onStep('Saving logo')
  const logoUri = args.logo ? (await center.pinImage(args.logo, { filename: args.logo.name })).uri : undefined
  args.onStep('Saving page details')
  return { projectUri: (await center.pinJson({ name: args.name, ...(logoUri ? { logoUri } : {}) })).uri, logoUri }
}

export type QuotedLaunch = PageLaunchSession

type LaunchArgs = {
  chainIds: PageChainId[]
  name: string
  logo: File | null
  owner: Address
  recipients: readonly PageRecipient[]
  onStep: (step: string) => void
  onSession?: (session: PageLaunchSession) => void
}

export function isSafeWallet(): boolean {
  const connector = getAccount(wagmiConfig).connector
  return connector?.id === 'safe' || connector?.type === 'safe'
}

function requireOwner(owner: Address) {
  const connected = getAccount(wagmiConfig).address
  if (!connected || !isAddressEqual(connected, owner)) throw new Error('Connect the wallet that started this launch.')
}

/** Only an explicit wallet rejection proves that a send did not reach the wallet. */
function rejected(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    const item = current as { code?: number; name?: string; cause?: unknown }
    if (item.code === 4001 || item.name === 'UserRejectedRequestError') return true
    current = item.cause
  }
  return false
}

function launchCalls(session: PageLaunchSession): RelayrCall[] {
  return session.chainIds.map(chainId => {
    const common = { chainId, owner: session.owner, projectUri: session.projectUri,
      creationFee: BigInt(session.fees[chainId]), splits: splitsOn(chainId, session.recipients, session.owner) }
    const tx = session.chainIds.length > 1
      ? pageOmnichainLaunchTx({ ...common, chainIds: session.chainIds, salt: session.id, mustStartAtOrAfter: session.mustStartAtOrAfter })
      : pageLaunchTx(common)
    return { chainId, to: tx.address, value: tx.value,
      data: encodeFunctionData({ abi: tx.abi, functionName: tx.functionName, args: tx.args } as never) }
  })
}

async function prepareSession(args: LaunchArgs): Promise<PageLaunchSession> {
  if (!supportsRelayrChains(args.chainIds)) throw new Error('Choose unique supported networks from one network environment.')
  const problem = recipientsProblem(args.recipients)
  if (problem) throw new Error(problem)
  requireOwner(args.owner)
  const existing = loadPageLaunch()
  if (existing) {
    if (existing.phase !== 'complete') throw new Error('A launch is already saved. Resume it before starting another.')
  }
  // Prove storage works before metadata upload or any wallet interaction.
  const probe = 'succulent:storage-check'
  localStorage.setItem(probe, '1')
  if (localStorage.getItem(probe) !== '1') throw new Error('Enable browser storage before launching a page.')
  localStorage.removeItem(probe)
  const { projectUri, logoUri } = await pinPage(args)
  const fees: Record<number, string> = {}
  for (const chainId of args.chainIds) {
    args.onStep(`Reading the creation fee on ${chainName(chainId)}`)
    fees[chainId] = (await getProjectCreationFee(client(chainId), chainId)).toString()
  }
  const session: PageLaunchSession = {
    version: 1, id: toHex(crypto.getRandomValues(new Uint8Array(32))), owner: args.owner,
    name: args.name, projectUri, logoUri, chainIds: [...args.chainIds], recipients: structuredClone([...args.recipients]),
    mustStartAtOrAfter: Math.floor(Date.now() / 1000), fees, transport: 'direct',
    phase: 'prepared', signed: [], direct: {}, launched: [],
  }
  if (session.chainIds.length > 1 && !isSafeWallet()) {
    const trusted = await Promise.all(launchCalls(session).map(async call => {
      const forwarder = jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][call.chainId]
      if (!forwarder) return false
      return client(call.chainId).readContract({ address: call.to,
        abi: [{ type: 'function', name: 'isTrustedForwarder', stateMutability: 'view', inputs: [{ name: 'forwarder', type: 'address' }], outputs: [{ type: 'bool' }] }],
        functionName: 'isTrustedForwarder', args: [forwarder] })
    }))
    if (trusted.every(Boolean)) session.transport = 'relayr'
  }
  savePageLaunch(session)
  args.onSession?.(structuredClone(session))
  return session
}

async function quoteSession(session: PageLaunchSession, onStep: (step: string) => void, persist: () => void) {
  if (isSafeWallet()) throw new Error('Reconnect the ordinary wallet that signed this Relayr launch.')
  let unboundQuote = session.phase === 'quoting' ? session.quote : undefined
  const calls = launchCalls(session)
  if (session.signed.some(item => item.deadline <= Math.floor(Date.now() / 1000) + 120)) {
    assertForwardRequestBindings(calls.slice(0, session.signed.length), session.owner, session.signed)
    for (const signed of session.signed) {
      const rpc = client(signed.entry.chain as PageChainId)
      const block = await rpc.getBlock({ blockTag: 'finalized' })
      const nonce = await rpc.readContract({ address: signed.entry.target, abi: erc2771ForwarderAbi,
        functionName: 'nonces', args: [session.owner], blockNumber: block.number })
      const canonical = await rpc.getBlock({ blockNumber: block.number })
      if (block.hash !== canonical.hash || block.timestamp <= BigInt(signed.deadline) || nonce !== BigInt(signed.nonce)) {
        throw new Error('The original launch signatures are not proven expired and unused. Check the original launch before signing again.')
      }
    }
    session.signed = []
    delete session.quote
    delete session.previousQuotes
    unboundQuote = undefined
    persist()
  }
  session.phase = 'signing'
  persist()
  const entries = await signForwardRequests(calls, session.owner, onStep, {
    signed: session.signed,
    onSigned: signed => { session.signed = signed; persist() },
  })
  session.phase = 'quoting'
  persist()
  onStep('Getting a quote from Relayr')
  // An expired/unreceived unfunded quote reuses the exact signed calls and their nonce.
  if (!unboundQuote && session.quote) {
    session.previousQuotes = [...(session.previousQuotes ?? []).filter(quote => quote.bundle_uuid !== session.quote!.bundle_uuid), session.quote]
    persist()
  }
  session.quote = unboundQuote ?? await requestQuote(entries)
  persist()
  session.quote = await bindQuote(session.quote, entries)
  session.previousQuotes = session.previousQuotes?.filter(quote => quote.bundle_uuid !== session.quote!.bundle_uuid)
  delete session.payment
  session.phase = 'quoted'
  persist()
  if (!paymentOptions(session.quote, session.chainIds).length) throw new Error('Relayr returned no valid payment options. Check again for a fresh quote.')
}

async function confirmedPage(call: RelayrCall, hash: Hex, safe?: { account: Address; proposal: Hex }, directOwner?: Address): Promise<LaunchedPage> {
  const rpc = client(call.chainId)
  const [tx, receipt] = await Promise.all([rpc.getTransaction({ hash }), rpc.getTransactionReceipt({ hash })])
  if (tx.hash !== hash || receipt.transactionHash !== hash || !tx.to || tx.chainId !== call.chainId ||
      tx.blockHash !== receipt.blockHash) throw new Error(`The transaction on ${chainName(call.chainId)} does not match this launch.`)
  if (directOwner && !safe && !isAddressEqual(tx.from, directOwner)) throw new Error('The direct launch came from a different account.')
  if (safe) verifySafeLaunch({ safe: safe.account, proposal: safe.proposal, call, to: tx.to, input: tx.input, receipt })
  else if (!isAddressEqual(tx.to, call.to) || tx.input.toLowerCase() !== call.data.toLowerCase() || tx.value !== call.value) {
    throw new Error(`The transaction on ${chainName(call.chainId)} does not match this launch.`)
  }
  const block = await rpc.getBlock({ blockNumber: receipt.blockNumber })
  if (block.hash !== receipt.blockHash) throw new Error('The launch receipt is no longer canonical. Check again.')
  if (receipt.status !== 'success') throw new Error(`The launch reverted on ${chainName(call.chainId)}. Its saved transaction will not be sent again automatically.`)
  const projectId = projectIdFromLogs(receipt.logs, call.chainId)
  if (projectId === null || !Number.isSafeInteger(projectId) || projectId <= 0) throw new Error(`The project ID on ${chainName(call.chainId)} could not be verified.`)
  return { chainId: call.chainId, projectId, hash }
}

async function runDirect(session: PageLaunchSession, onStep: (step: string) => void, persist: () => void): Promise<LaunchedPage[]> {
  for (const call of launchCalls(session)) {
    let record = session.direct[call.chainId]
    if (record?.phase === 'sending' && !record.hash) throw new Error(`The wallet submission on ${chainName(call.chainId)} is uncertain. Check the original wallet transaction; do not launch again.`)
    if (!record) {
      onStep(`Confirm the launch on ${chainName(call.chainId)}`)
      await onChain(call.chainId)
      requireOwner(session.owner)
      await client(call.chainId).call({ account: session.owner, to: call.to, data: call.data, value: call.value })
      requireOwner(session.owner)
      const safe = isSafeWallet()
      session.direct[call.chainId] = { phase: 'sending' }
      persist()
      let hash: Hex
      try {
        hash = await sendTransaction(wagmiConfig, { chainId: call.chainId, account: session.owner, to: call.to, data: call.data, value: call.value })
      } catch (error) {
        if (rejected(error)) { delete session.direct[call.chainId]; persist() }
        throw error
      }
      record = safe ? { phase: 'submitted', safeProposal: hash } : { phase: 'submitted', hash }
      session.direct[call.chainId] = record
      persist()
    }
    if (record.safeProposal && !record.hash) {
      record.hash = await safeExecutionHash(call.chainId, record.safeProposal)
      persist()
    }
    if (!record.hash) throw new Error('The original launch hash is unavailable. Do not send another launch.')
    onStep(`Checking the launch on ${chainName(call.chainId)}`)
    await client(call.chainId).waitForTransactionReceipt({ hash: record.hash, timeout: 90_000 })
    const page = await confirmedPage(call, record.hash, record.safeProposal ? { account: session.owner, proposal: record.safeProposal } : undefined, session.owner)
    session.launched = [...session.launched.filter(item => item.chainId !== call.chainId), page]
    record.phase = 'complete'
    persist()
  }
  session.phase = 'complete'
  persist()
  return session.launched
}

/** Pin once and save the complete plan before signing; all subsequent attempts resume that plan. */
export async function quoteMultichainPage(args: LaunchArgs): Promise<QuotedLaunch> {
  return withPageLaunchLock(async () => {
    const session = await prepareSession(args)
    const persist = () => { savePageLaunch(session); args.onSession?.(structuredClone(session)) }
    if (session.transport === 'direct') await runDirect(session, args.onStep, persist)
    else await quoteSession(session, args.onStep, persist)
    return structuredClone(session)
  })
}

/** Resume an unfunded quote without rebuilding its pinned launch or changing any signed nonce. */
export async function resumePageQuote(args: {
  session: PageLaunchSession; owner: Address; onStep: (step: string) => void; onSession?: (session: PageLaunchSession) => void
  safeExecutionHashes?: Partial<Record<PageChainId, Hex>>
}): Promise<PageLaunchSession> {
  return withPageLaunchLock(async () => {
    const session = loadPageLaunch()
    if (!session || session.id !== args.session.id || !isAddressEqual(session.owner, args.owner)) throw new Error('The saved launch changed. Reload before continuing.')
    requireOwner(args.owner)
    const persist = () => { savePageLaunch(session); args.onSession?.(structuredClone(session)) }
    if (session.transport === 'direct') {
      for (const [id, hash] of Object.entries(args.safeExecutionHashes ?? {})) {
        const record = session.direct[Number(id) as PageChainId]
        if (!record?.safeProposal || !hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Enter an execution hash for one of the saved Safe proposals.')
        record.hash = hash
        persist()
      }
      await runDirect(session, args.onStep, persist)
    } else {
      if (['payment-sending', 'submitted', 'executing'].includes(session.phase)) throw new Error('Check the original Relayr payment before requesting any quote.')
      await quoteSession(session, args.onStep, persist)
    }
    return structuredClone(session)
  })
}

/** One explicitly chosen quoted payment, then canonical receipt checks on every destination. */
export async function launchQuotedPage(args: {
  quoted: QuotedLaunch
  payment?: ChainPayment
  owner: Address
  onStep: (step: string) => void
  onSession?: (session: PageLaunchSession) => void
  onProgress: (states: { chainId: number; state: string; hash?: Hex }[]) => void
}): Promise<LaunchedPage[]> {
  return withPageLaunchLock(async () => {
    const session = loadPageLaunch()
    if (!session || session.id !== args.quoted.id || !isAddressEqual(session.owner, args.owner)) throw new Error('The saved launch changed. Reload before continuing.')
    requireOwner(args.owner)
    const persist = () => { savePageLaunch(session); args.onSession?.(structuredClone(session)) }
    if (session.transport === 'direct') return runDirect(session, args.onStep, persist)
    if (!session.quote || session.signed.length !== session.chainIds.length) throw new Error('Resume signing this saved launch first.')
    assertForwardRequestBindings(launchCalls(session), session.owner, session.signed)
    const fundingStarted = ['payment-sending', 'submitted', 'executing', 'complete'].includes(session.phase)
    if (fundingStarted && session.paymentHash && session.payment) {
      const hash = session.paymentHash
      const payment = session.payment
      const rpc = client(payment.chain as PageChainId)
      // A temporary payment RPC outage does not prevent checking destination evidence.
      const evidence = await Promise.all([rpc.getTransaction({ hash }), rpc.getTransactionReceipt({ hash })])
        .then(async ([tx, receipt]) => ({ tx, receipt, block: await rpc.getBlock({ blockNumber: receipt.blockNumber }) }))
        .catch(() => null)
      if (evidence) {
        const { tx, receipt, block } = evidence
        if (tx.hash !== hash || receipt.transactionHash !== hash || tx.chainId !== payment.chain ||
            !tx.to || !isAddressEqual(tx.to, payment.target) || !isAddressEqual(tx.from, session.owner) ||
            tx.input.toLowerCase() !== payment.calldata.toLowerCase() || tx.value !== BigInt(payment.amount) ||
            tx.blockHash !== receipt.blockHash || block.hash !== receipt.blockHash) throw new Error('The saved payment could not be verified. Keep checking the original launch without another payment.')
        if (receipt.status === 'reverted') {
          const finalized = await rpc.getBlock({ blockTag: 'finalized' })
          const canonical = await rpc.getBlock({ blockNumber: finalized.number })
          const receiptBlock = await rpc.getBlock({ blockNumber: receipt.blockNumber })
          if (finalized.hash !== canonical.hash || receiptBlock.hash !== receipt.blockHash || receipt.blockNumber > finalized.number) {
            throw new Error('The original payment reverted but is not finalized. Check again before another payment.')
          }
          session.failedPayments = [...(session.failedPayments ?? []), { chainId: payment.chain, hash }]
          delete session.paymentHash
          delete session.payment
          session.phase = 'quoted'
          persist()
          throw new Error('The original Relayr payment reverted on chain. Choose a quote again to retry that payment.')
        }
      }
    }
    if (!fundingStarted) {
      if (session.phase !== 'quoted') throw new Error('Resume the saved Relayr quote before choosing a payment.')
      const selected = args.payment && paymentOptions(session.quote, session.chainIds).find(item => item.chain === args.payment!.chain &&
        item.target.toLowerCase() === args.payment!.target.toLowerCase() && item.calldata.toLowerCase() === args.payment!.calldata.toLowerCase() && BigInt(item.amount) === BigInt(args.payment!.amount))
      if (!selected) throw new Error('Choose one of the current Relayr quote options before paying.')
      args.onStep(`Pay on ${chainName(selected.chain)} in your wallet`)
      session.payment = structuredClone(selected)
      persist()
      try {
        await payQuote(selected, args.owner, { bundleUuid: session.quote.bundle_uuid, destinationChainIds: session.chainIds,
          reverify: async () => {
            await verifyForwardRequests(launchCalls(session), session.owner, session.signed)
            for (const quote of [session.quote!, ...(session.previousQuotes ?? [])]) {
              const original = await getBundle(quote.bundle_uuid, session.signed.map(item => item.entry), quote.expectedTransactions)
              if (original.payment_received || original.transactions.some(item => bundleHash(item))) {
                session.phase = 'executing'; persist()
                throw new Error('Relayr already has funding or execution evidence for this launch. Check its original status without another payment.')
              }
            }
          },
          onSending: () => { session.phase = 'payment-sending'; persist() },
          onSubmitted: hash => { session.paymentHash = hash; session.phase = 'submitted'; persist() },
        })
      } catch (error) {
        if (rejected(error) && !session.paymentHash) { session.phase = 'quoted'; delete session.payment; persist() }
        throw error
      }
    }
    args.onStep('Checking the original Relayr launch on every network')
    const entries = session.signed.map(item => item.entry)
    let statusError: unknown
    for (let attempt = 0; attempt < 24; attempt++) {
      for (const quote of [session.quote, ...(session.previousQuotes ?? [])]) {
        try {
          const update = await getBundle(quote.bundle_uuid, entries, quote.expectedTransactions)
          for (const transaction of update.transactions) {
            const hash = bundleHash(transaction)
            if (!hash) continue
            const chainId = transaction.request.chain as PageChainId
            session.candidates = { ...session.candidates,
              [chainId]: [...new Set([...(session.candidates?.[chainId] ?? []), hash])] }
          }
          persist()
        } catch (error) { statusError = error }
      }
      // Persist and verify each available destination even while another chain or the API is unavailable.
      for (const entry of entries) {
        const chainId = entry.chain as PageChainId
        const known = session.launched.find(item => item.chainId === chainId)?.hash
        const hashes = [...new Set([...(known ? [known] : []), ...(session.candidates?.[chainId] ?? [])])]
        let confirmed: LaunchedPage | undefined
        for (const hash of hashes) {
          try {
            confirmed = await confirmedPage({ chainId, to: entry.target, data: entry.data, value: BigInt(entry.value) }, hash)
            break
          } catch (error) { statusError = error }
        }
        session.launched = session.launched.filter(item => item.chainId !== chainId)
        if (confirmed) session.launched.push(confirmed)
        persist()
      }
      args.onProgress(session.chainIds.map(chainId => ({ chainId,
        state: session.launched.some(item => item.chainId === chainId) ? 'Completed' : 'Checking confirmation',
        hash: session.launched.find(item => item.chainId === chainId)?.hash ?? session.candidates?.[chainId]?.[0] })))
      if (session.launched.length === session.chainIds.length) break
      if (statusError || attempt === 23) throw statusError ?? new Error('Some destinations are still pending. Check the original launch again without another payment.')
      await new Promise(resolve => setTimeout(resolve, 2500))
    }
    session.phase = 'complete'
    persist()
    return structuredClone(session.launched)
  })
}

/** Single-network creation uses the same durable direct-send recovery as an omnichain Safe launch. */
export async function createPage(args: Omit<LaunchArgs, 'chainIds'> & { chainId: PageChainId }): Promise<LaunchedPage> {
  const session = await quoteMultichainPage({ ...args, chainIds: [args.chainId] })
  return session.launched[0]
}

/** A one-line reason a wallet call failed, without viem's multi-paragraph dump. */
export function failureReason(error: unknown): string {
  const short = (error as { shortMessage?: string })?.shortMessage
  const message = short ?? (error instanceof Error ? error.message : String(error))
  if (/rejected|denied/i.test(message)) return 'Cancelled in wallet.'
  return message.split('\n')[0].slice(0, 200)
}
