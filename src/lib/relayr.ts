'use client'

import { JBCoreContracts, erc2771ForwarderAbi, jbContractAddress } from '@bananapus/nana-sdk-core'
import { encodeFunctionData, isAddress, parseEther, type Address, type Hex } from 'viem'
import { getAccount, getPublicClient, sendTransaction, signTypedData, switchChain, waitForTransactionReceipt } from 'wagmi/actions'
import { chainName } from './chains'
import { wagmiConfig, type PageChainId } from './wagmi'

/**
 * Relayr, the way juicebox.money and revnet.money use it: one EIP-712 ForwardRequest signature per
 * destination chain (no gas there), one prepaid quote, one payment on a chain of the payer's choosing,
 * then Relayr executes every destination call through the Juicebox ERC-2771 forwarder.
 */
const RELAYR_API = 'https://api.relayr.ba5ed.com'
/** How long a signed ForwardRequest stays executable; the forwarder rejects it after. */
const FORWARDER_DEADLINE_SECONDS = 47 * 60 * 60
/** When the destination call cannot be estimated (the signer holds no ETH there), a generous limit; Relayr re-simulates. */
const FALLBACK_GAS = 8_000_000n

const FORWARD_REQUEST_TYPES = {
  ForwardRequest: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'gas', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint48' },
    { name: 'data', type: 'bytes' },
  ],
} as const

export type RelayrCall = { chainId: PageChainId; to: Address; data: Hex; value: bigint }
export type RelayrEntry = { chain: number; target: Address; data: Hex; value: string }
export type ChainPayment = { chain: number; target: Address; amount: Hex | string; calldata: Hex; payment_deadline?: string | number; token?: Address }
export type RelayrQuote = { bundle_uuid: string; payment_info: ChainPayment[] }
export type RelayrBundle = {
  bundle_uuid: string
  payment_received?: boolean
  transactions: { tx_uuid: string; request: { chain: number }; status?: { state?: string; data?: { hash?: Hex; transaction?: { hash?: Hex } } } }[]
}

function ensureAccount(expected: Address) {
  const live = getAccount(wagmiConfig).address
  if (!live || live.toLowerCase() !== expected.toLowerCase()) throw new Error('Connected account changed. Start the launch again.')
}

/**
 * Sign one ForwardRequest per call. The wallet switches to each chain first: the EIP-712 domain's
 * chainId is the destination chain, and wallets refuse to sign a domain for a chain they are not on.
 */
export async function signForwardRequests(calls: RelayrCall[], account: Address, onStep: (step: string) => void): Promise<RelayrEntry[]> {
  const entries: RelayrEntry[] = []
  for (const [index, call] of calls.entries()) {
    const forwarder = jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][call.chainId] as Address | undefined
    if (!forwarder) throw new Error(`No Juicebox forwarder on ${chainName(call.chainId)}.`)
    onStep(`Sign for ${chainName(call.chainId)} (${index + 1}/${calls.length})`)
    await switchChain(wagmiConfig, { chainId: call.chainId })
    ensureAccount(account)
    const client = getPublicClient(wagmiConfig, { chainId: call.chainId })
    if (!client) throw new Error(`${chainName(call.chainId)} is unavailable.`)
    // Estimate the destination call as if sent directly, with the creation fee pretend-funded so a
    // signer holding no ETH on that chain still gets a real estimate. Relayr re-simulates server-side.
    const gas = await client
      .estimateGas({
        account,
        to: call.to,
        data: call.data,
        value: call.value,
        stateOverride: [{ address: account, balance: call.value + parseEther('1') }],
      })
      .then(estimate => estimate * 2n)
      .catch(() => FALLBACK_GAS)
    const [domain, nonce] = await Promise.all([
      client.readContract({ address: forwarder, abi: erc2771ForwarderAbi, functionName: 'eip712Domain' }),
      client.readContract({ address: forwarder, abi: erc2771ForwarderAbi, functionName: 'nonces', args: [account] }),
    ])
    const request = {
      from: account,
      to: call.to,
      value: call.value,
      gas,
      nonce,
      deadline: Math.floor(Date.now() / 1000) + FORWARDER_DEADLINE_SECONDS,
      data: call.data,
    }
    const signature = await signTypedData(wagmiConfig, {
      account,
      domain: { name: domain[1], version: domain[2], chainId: call.chainId, verifyingContract: forwarder },
      types: FORWARD_REQUEST_TYPES,
      primaryType: 'ForwardRequest',
      message: request,
    })
    ensureAccount(account)
    entries.push({
      chain: call.chainId,
      target: forwarder,
      data: encodeFunctionData({
        abi: erc2771ForwarderAbi,
        functionName: 'execute',
        args: [{ from: request.from, to: request.to, value: request.value, gas: request.gas, deadline: request.deadline, data: request.data, signature }],
      }),
      value: call.value.toString(),
    })
  }
  return entries
}

/** Ask Relayr what the bundle costs; it answers with one payable option per chain it accepts payment on. */
export async function requestQuote(entries: RelayrEntry[]): Promise<RelayrQuote> {
  const response = await fetch(`${RELAYR_API}/v1/bundle/prepaid`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transactions: entries, virtual_nonce_mode: 'Disabled' }),
    signal: AbortSignal.timeout(45_000),
  })
  if (!response.ok) throw new Error(`Relayr could not quote this launch (${response.status}). ${(await response.text()).slice(0, 200)}`)
  const quote = (await response.json()) as RelayrQuote
  if (!quote.bundle_uuid?.trim() || !Array.isArray(quote.payment_info) || !quote.payment_info.length) {
    throw new Error('Relayr returned an incomplete quote.')
  }
  return quote
}

/** Pay the quote on the chosen chain. Relayr starts executing the destination calls once this confirms. */
export async function payQuote(payment: ChainPayment, account: Address): Promise<Hex> {
  if (!isAddress(payment.target) || !/^0x(?:[0-9a-fA-F]{2})*$/.test(payment.calldata)) throw new Error('Relayr returned an invalid payment.')
  const deadline = Number(payment.payment_deadline)
  if (Number.isSafeInteger(deadline) && deadline <= Math.floor(Date.now() / 1000) + 15) throw new Error('This quote expired. Sign again for a fresh one.')
  const chainId = payment.chain as PageChainId
  await switchChain(wagmiConfig, { chainId })
  ensureAccount(account)
  const hash = await sendTransaction(wagmiConfig, { chainId, to: payment.target, value: BigInt(payment.amount), data: payment.calldata })
  await waitForTransactionReceipt(wagmiConfig, { hash, chainId })
  return hash
}

export function bundleHash(transaction: RelayrBundle['transactions'][number]): Hex | undefined {
  return transaction.status?.data?.hash ?? transaction.status?.data?.transaction?.hash
}

const succeeded = (state?: string) => /^(success|completed)$/i.test(state ?? '')
const failed = (state?: string) => /^(failed|reverted|dropped)$/i.test(state ?? '')

/** Poll the bundle until every destination call has landed. Records come back in submission order. */
export async function waitForBundle(bundleUuid: string, onUpdate: (bundle: RelayrBundle) => void): Promise<RelayrBundle> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const response = await fetch(`${RELAYR_API}/v1/bundle/${bundleUuid}`, { signal: AbortSignal.timeout(15_000) })
      if (response.ok) {
        const bundle = (await response.json()) as RelayrBundle
        onUpdate(bundle)
        const states = bundle.transactions.map(transaction => transaction.status?.state)
        if (states.some(failed)) throw new Error('Relayr reported a failed launch on one network. The paid bundle will not be retried automatically.')
        if (states.length && states.every(succeeded)) return bundle
      }
    } catch (error) {
      if (error instanceof Error && /failed launch/.test(error.message)) throw error
      // Status endpoint hiccup: keep polling, the payment is already made.
    }
    await new Promise(resolve => setTimeout(resolve, 2_500))
  }
  throw new Error('Relayr is still executing after several minutes. Do not pay again; the launches will still land.')
}
