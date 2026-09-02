'use client'

import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core'
import type { PayOption } from './pay-options'
import { createJBCenterClient } from '@bananapus/nana-sdk-core/jbcenter'
import { buildPayTx, getProjectCreationFee, projectIdFromLaunchLogs, resolvePaymentTerminal } from '@bananapus/nana-sdk-core/v6'
import { getPublicClient, readContract, switchChain, waitForTransactionReceipt, writeContract } from 'wagmi/actions'
import { erc20Abi, toHex, type Address, type Hex, type PublicClient } from 'viem'
import { pageLaunchTx, pageOmnichainLaunchTx, type PageSplit } from './page-launch'
import type { PageRef } from './bendystraw'
import { chainName } from './chains'
import { wagmiConfig, type PageChainId } from './wagmi'

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
 * Pin the Page's logo and metadata once, then launch it on every selected chain, one wallet
 * confirmation per chain. `onLaunched` fires per chain so a failure midway still leaves the
 * caller holding the pages that did land.
 */
export async function createPage(args: {
  chainIds: PageChainId[]
  name: string
  logo: File | null
  owner: Address
  recipients: readonly PageRecipient[]
  onStep: (step: string) => void
  onLaunched: (page: LaunchedPage) => void
}): Promise<LaunchedPage[]> {
  const early = recipientsProblem(args.recipients)
  if (early) throw new Error(early)
  args.onStep('Saving logo')
  const logoUri = args.logo ? (await center.pinImage(args.logo, { filename: args.logo.name })).uri : undefined
  args.onStep('Saving page details')
  const { uri: projectUri } = await center.pinJson({ name: args.name, ...(logoUri ? { logoUri } : {}) })

  const multi = args.chainIds.length > 1
  const salt = toHex(crypto.getRandomValues(new Uint8Array(32)))
  const mustStartAtOrAfter = Math.floor(Date.now() / 1000)
  const launched: LaunchedPage[] = []
  for (const [index, chainId] of args.chainIds.entries()) {
    const where = multi ? ` on ${chainName(chainId)} (${index + 1}/${args.chainIds.length})` : ''
    args.onStep(`Confirm in your wallet${where}`)
    const creationFee = await getProjectCreationFee(client(chainId), chainId)
    const splits = splitsOn(chainId, args.recipients, args.owner)
    const tx = multi
      ? pageOmnichainLaunchTx({ chainId, chainIds: args.chainIds, owner: args.owner, projectUri, creationFee, salt, mustStartAtOrAfter, splits })
      : pageLaunchTx({ chainId, owner: args.owner, projectUri, creationFee, splits })
    await onChain(chainId)
    // The SDK builders return an overload union (6- or 7-arg launch) wagmi's generics cannot
    // narrow; both are fully typed viem requests built above, so the write skips re-inference.
    const hash = await writeContract(wagmiConfig, { ...tx, chainId } as never)
    args.onStep(`Waiting for confirmation${where}`)
    const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId })
    const projectId = projectIdFromLaunchLogs(receipt.logs, { chainId })
    if (projectId === null) throw new Error(`The page launched on ${chainName(chainId)} but its id could not be read from the receipt.`)
    const page = { chainId, projectId: Number(projectId), hash }
    launched.push(page)
    args.onLaunched(page)
  }
  return launched
}

/** A one-line reason a wallet call failed, without viem's multi-paragraph dump. */
export function failureReason(error: unknown): string {
  const short = (error as { shortMessage?: string })?.shortMessage
  const message = short ?? (error instanceof Error ? error.message : String(error))
  if (/rejected|denied/i.test(message)) return 'Cancelled in wallet.'
  return message.split('\n')[0].slice(0, 200)
}
