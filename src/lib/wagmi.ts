'use client'

import { createConfig, fallback, http } from 'wagmi'
import { arbitrum, base, mainnet, optimism } from 'wagmi/chains'
import { injected } from 'wagmi/connectors/injected'
import { IS_DETERMINISTIC_BROWSER, PARA_EMBEDDED_WALLET_ENABLED } from './browserEnvironment'
import { lazyParaConnector } from '@/providers/lazy-para-connector'
import { externalWalletConnectors } from '@/providers/wallet-connectors'

export const CHAINS = [base, mainnet, optimism, arbitrum] as const
export type PageChainId = (typeof CHAINS)[number]['id']

// Static keys so Next inlines them; unset falls back to each chain's public RPC.
const RPC: Record<number, string | undefined> = {
  1: process.env.NEXT_PUBLIC_RPC_1,
  10: process.env.NEXT_PUBLIC_RPC_10,
  8453: process.env.NEXT_PUBLIC_RPC_8453,
  42161: process.env.NEXT_PUBLIC_RPC_42161,
}

// The chains' default public RPCs rate-limit quickly (mainnet.base.org answered "over rate limit" in
// testing), so each chain tries the configured RPC, then publicnode, then the default.
const PUBLICNODE: Record<number, string> = {
  1: 'https://ethereum-rpc.publicnode.com',
  10: 'https://optimism-rpc.publicnode.com',
  8453: 'https://base-rpc.publicnode.com',
  42161: 'https://arbitrum-one-rpc.publicnode.com',
}
const transport = (chainId: number) =>
  fallback([...(RPC[chainId] ? [http(RPC[chainId])] : []), http(PUBLICNODE[chainId]), http()])

export const transports = {
  [mainnet.id]: transport(1),
  [optimism.id]: transport(10),
  [base.id]: transport(8453),
  [arbitrum.id]: transport(42161),
}

/**
 * EIP-6963 discovers browser wallets without vendor SDKs. Para, WalletConnect, Coinbase,
 * and Safe sit behind lazy delegates so their SDKs load only when picked or restored.
 */
export const wagmiConfig = createConfig({
  chains: CHAINS,
  transports,
  connectors: IS_DETERMINISTIC_BROWSER
    ? []
    : PARA_EMBEDDED_WALLET_ENABLED
      ? [injected({ shimDisconnect: true }), lazyParaConnector(), ...externalWalletConnectors()]
      : [injected({ shimDisconnect: true }), ...externalWalletConnectors()],
  multiInjectedProviderDiscovery: !IS_DETERMINISTIC_BROWSER,
  ssr: true,
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
