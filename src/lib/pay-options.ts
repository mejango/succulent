'use client'

import { NATIVE_TOKEN, USDC_ADDRESSES, type JBChainId } from '@bananapus/nana-sdk-core'
import { getAccountingContexts, v6Address } from '@bananapus/nana-sdk-core/v6'
import type { Address, PublicClient } from 'viem'

/** A way to pay a page: a token it accepts directly, or one the router swaps into what it accepts. */
export type PayOption = { symbol: 'ETH' | 'USDC'; token: Address; decimals: number; viaRouter: boolean }

/**
 * ETH and USDC, in the order the page accepts them: directly accepted tokens first (so a USDC page
 * defaults to USDC), then the other one through the router terminal when the chain has one.
 * Mirrors juicebox.money's pay card.
 */
export async function payOptionsFor(client: PublicClient, chainId: JBChainId, projectId: number): Promise<PayOption[]> {
  const contexts = await getAccountingContexts(client, { chainId, projectId: BigInt(projectId) })
  const usdc = USDC_ADDRESSES[chainId]
  const known: PayOption[] = [
    { symbol: 'ETH', token: NATIVE_TOKEN, decimals: 18, viaRouter: false },
    ...(usdc ? [{ symbol: 'USDC' as const, token: usdc, decimals: 6, viaRouter: false }] : []),
  ]
  const accepted = (token: Address) => contexts.some(context => context.token.toLowerCase() === token.toLowerCase())
  const direct = known.filter(option => accepted(option.token))
  let router = false
  try {
    v6Address('JBRouterTerminalRegistry', chainId)
    router = true
  } catch {
    // No router on this chain: only directly accepted tokens can pay.
  }
  const swapped = router ? known.filter(option => !accepted(option.token)).map(option => ({ ...option, viaRouter: true })) : []
  return [...direct, ...swapped]
}
