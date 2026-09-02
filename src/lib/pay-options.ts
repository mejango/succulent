'use client'

import { NATIVE_TOKEN, USDC_ADDRESSES, type JBChainId } from '@bananapus/nana-sdk-core'
import { getAccountingContexts, previewPay, resolvePaymentTerminal } from '@bananapus/nana-sdk-core/v6'
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
  // A token the page does not account in still pays if JBDirectory resolves a terminal for it (the
  // page's own router terminal, or the registry) AND that terminal can quote it. A cold registry
  // reverts on the quote, so the option is dropped rather than shown and failing at send time.
  const swapped = await Promise.all(
    known
      .filter(option => !accepted(option.token))
      .map(async option => {
        try {
          const terminal = await resolvePaymentTerminal(client, { chainId, projectId: BigInt(projectId), token: option.token })
          await previewPay(client, {
            chainId,
            terminal: terminal.address,
            projectId: BigInt(projectId),
            token: option.token,
            amount: 10n ** BigInt(option.decimals - 3),
            beneficiary: '0x1111111111111111111111111111111111111111',
          })
          return { ...option, viaRouter: true }
        } catch {
          return null
        }
      }),
  )
  return [...direct, ...swapped.filter((option): option is PayOption => option !== null)]
}
