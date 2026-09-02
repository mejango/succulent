'use client'

import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core'
import type { PayOption } from './pay-options'
import { createJBCenterClient } from '@bananapus/nana-sdk-core/jbcenter'
import { buildPayTx, getProjectCreationFee, resolvePaymentTerminal } from '@bananapus/nana-sdk-core/v6'
import { getPublicClient, readContract, switchChain, waitForTransactionReceipt, writeContract } from 'wagmi/actions'
import { encodeFunctionData, erc20Abi, parseEventLogs, toHex, type Address, type Hex, type Log, type PublicClient } from 'viem'
import { jbControllerAbi } from '@bananapus/nana-sdk-core'
import { pageLaunchTx, pageOmnichainLaunchTx, type PageSplit } from './page-launch'
import type { PageRef } from './bendystraw'
import { chainName } from './chains'
import { wagmiConfig, type PageChainId } from './wagmi'
import { payQuote, requestQuote, signForwardRequests, waitForBundle, bundleHash, type ChainPayment, type RelayrQuote } from './relayr'

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
 * The project id from a launch receipt: JBController's LaunchProject event, whichever controller
 * emitted it (the omnichain deployer's controller differs from the SDK's address table).
 */
export function projectIdFromLogs(logs: Log[]): number | null {
  const events = parseEventLogs({ abi: jbControllerAbi, eventName: 'LaunchProject', logs, strict: false })
  const projectId = events[0]?.args.projectId
  return projectId === undefined ? null : Number(projectId)
}

async function pinPage(args: { name: string; logo: File | null; onStep: (step: string) => void }): Promise<string> {
  args.onStep('Saving logo')
  const logoUri = args.logo ? (await center.pinImage(args.logo, { filename: args.logo.name })).uri : undefined
  args.onStep('Saving page details')
  return (await center.pinJson({ name: args.name, ...(logoUri ? { logoUri } : {}) })).uri
}

/** A page on ONE network: pin, then one JBController launch from the wallet. */
export async function createPage(args: {
  chainId: PageChainId
  name: string
  logo: File | null
  owner: Address
  recipients: readonly PageRecipient[]
  onStep: (step: string) => void
}): Promise<LaunchedPage> {
  const problem = recipientsProblem(args.recipients)
  if (problem) throw new Error(problem)
  const { chainId } = args
  const projectUri = await pinPage(args)
  args.onStep('Confirm in your wallet')
  const creationFee = await getProjectCreationFee(client(chainId), chainId)
  const tx = pageLaunchTx({ chainId, owner: args.owner, projectUri, creationFee, splits: splitsOn(chainId, args.recipients, args.owner) })
  await onChain(chainId)
  const hash = await writeContract(wagmiConfig, { ...tx, chainId } as never)
  args.onStep('Waiting for confirmation')
  const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId })
  const projectId = projectIdFromLogs(receipt.logs)
  if (projectId === null) throw new Error(`The page launched on ${chainName(chainId)} but its id could not be read from the receipt.`)
  return { chainId, projectId, hash }
}

export type QuotedLaunch = { quote: RelayrQuote; chainIds: PageChainId[] }

/**
 * A page on SEVERAL networks, the way juicebox.money and revnet.money do it: pin once, build one
 * JBOmnichainDeployer launch per chain with a shared salt and start, sign a ForwardRequest for each
 * (a wallet signature per chain, no gas), and get Relayr's prepaid quote. Nothing is sent yet.
 */
export async function quoteMultichainPage(args: {
  chainIds: PageChainId[]
  name: string
  logo: File | null
  owner: Address
  recipients: readonly PageRecipient[]
  onStep: (step: string) => void
}): Promise<QuotedLaunch> {
  const problem = recipientsProblem(args.recipients)
  if (problem) throw new Error(problem)
  const projectUri = await pinPage(args)
  const salt = toHex(crypto.getRandomValues(new Uint8Array(32)))
  const mustStartAtOrAfter = Math.floor(Date.now() / 1000)
  const calls = []
  for (const chainId of args.chainIds) {
    args.onStep(`Reading the creation fee on ${chainName(chainId)}`)
    const creationFee = await getProjectCreationFee(client(chainId), chainId)
    const tx = pageOmnichainLaunchTx({
      chainId,
      chainIds: args.chainIds,
      owner: args.owner,
      projectUri,
      creationFee,
      salt,
      mustStartAtOrAfter,
      splits: splitsOn(chainId, args.recipients, args.owner),
    })
    calls.push({
      chainId,
      to: tx.address,
      // The forward request's value IS the creation fee: the forwarder passes it through and Relayr's quote covers it.
      value: tx.value,
      data: encodeFunctionData({ abi: tx.abi, functionName: tx.functionName, args: tx.args } as never),
    })
  }
  const entries = await signForwardRequests(calls, args.owner, args.onStep)
  args.onStep('Getting a quote from Relayr')
  return { quote: await requestQuote(entries), chainIds: args.chainIds }
}

/** Pay the quote on the chosen chain, then follow Relayr until every network has the page. */
export async function launchQuotedPage(args: {
  quoted: QuotedLaunch
  payment: ChainPayment
  owner: Address
  onStep: (step: string) => void
  onProgress: (states: { chainId: number; state: string; hash?: Hex }[]) => void
}): Promise<LaunchedPage[]> {
  args.onStep(`Pay on ${chainName(args.payment.chain)} in your wallet`)
  await payQuote(args.payment, args.owner)
  args.onStep('Relayr is launching on each network')
  const bundle = await waitForBundle(args.quoted.quote.bundle_uuid, update =>
    args.onProgress(
      // Records come back in submission order, the order the chains were signed in.
      update.transactions.map((transaction, index) => ({
        chainId: args.quoted.chainIds[index] ?? Number(transaction.request?.chain),
        state: transaction.status?.state ?? 'Pending',
        hash: bundleHash(transaction),
      })),
    ),
  )
  const launched: LaunchedPage[] = []
  for (const [index, transaction] of bundle.transactions.entries()) {
    const chainId = args.quoted.chainIds[index]
    const hash = bundleHash(transaction)
    if (!hash) continue
    const receipt = await client(chainId).getTransactionReceipt({ hash })
    const projectId = projectIdFromLogs(receipt.logs)
    if (projectId !== null) launched.push({ chainId, projectId, hash })
  }
  if (!launched.length) throw new Error('Relayr finished but no launch could be read back. Check the transactions on each network.')
  return launched
}

/** A one-line reason a wallet call failed, without viem's multi-paragraph dump. */
export function failureReason(error: unknown): string {
  const short = (error as { shortMessage?: string })?.shortMessage
  const message = short ?? (error instanceof Error ? error.message : String(error))
  if (/rejected|denied/i.test(message)) return 'Cancelled in wallet.'
  return message.split('\n')[0].slice(0, 200)
}
