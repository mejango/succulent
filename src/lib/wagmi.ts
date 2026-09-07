'use client'

import { createConfig, fallback, http } from 'wagmi'
import { arbitrum, arbitrumSepolia, base, baseSepolia, mainnet, optimism, optimismSepolia, sepolia } from 'wagmi/chains'
import { injected } from 'wagmi/connectors/injected'
import { IS_DETERMINISTIC_BROWSER, PARA_EMBEDDED_WALLET_ENABLED } from './browserEnvironment'
import { jbCenterRpcTransport } from './jbcenter-rpc'
import { lazyParaConnector } from '@/providers/lazy-para-connector'
import { externalWalletConnectors } from '@/providers/wallet-connectors'

export const MAINNET_CHAINS = [base, mainnet, optimism, arbitrum] as const
export const TESTNET_CHAINS = [baseSepolia, sepolia, optimismSepolia, arbitrumSepolia] as const
export const CHAINS = [...MAINNET_CHAINS, ...TESTNET_CHAINS] as const
export type PageChainId = (typeof CHAINS)[number]['id']

// Static keys so Next inlines them; unset falls back to each chain's public RPC.
const RPC: Record<number, string | undefined> = {
  1: process.env.NEXT_PUBLIC_RPC_1,
  10: process.env.NEXT_PUBLIC_RPC_10,
  8453: process.env.NEXT_PUBLIC_RPC_8453,
  42161: process.env.NEXT_PUBLIC_RPC_42161,
  11155111: process.env.NEXT_PUBLIC_RPC_11155111,
  11155420: process.env.NEXT_PUBLIC_RPC_11155420,
  84532: process.env.NEXT_PUBLIC_RPC_84532,
  421614: process.env.NEXT_PUBLIC_RPC_421614,
}

// juicebox.center's RPC first (the transport juicebox.money uses; it allowlists succulent.money once
// jbcenter PR #17 is deployed and 403s until then), then a configured RPC, then publicnode, then the
// chain default. viem's fallback skips a transport that errors. mainnet.base.org rate-limits eth_call.
const PUBLICNODE: Record<number, string> = {
  1: 'https://ethereum-rpc.publicnode.com',
  10: 'https://optimism-rpc.publicnode.com',
  8453: 'https://base-rpc.publicnode.com',
  42161: 'https://arbitrum-one-rpc.publicnode.com',
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
  11155420: 'https://optimism-sepolia-rpc.publicnode.com',
  84532: 'https://base-sepolia-rpc.publicnode.com',
  421614: 'https://arbitrum-sepolia-rpc.publicnode.com',
}
const transport = (chainId: number) =>
  fallback([jbCenterRpcTransport(chainId), ...(RPC[chainId] ? [http(RPC[chainId])] : []), http(PUBLICNODE[chainId]), http()])

export const transports = {
  [mainnet.id]: transport(1),
  [optimism.id]: transport(10),
  [base.id]: transport(8453),
  [arbitrum.id]: transport(42161),
  [sepolia.id]: transport(11155111),
  [optimismSepolia.id]: transport(11155420),
  [baseSepolia.id]: transport(84532),
  [arbitrumSepolia.id]: transport(421614),
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
