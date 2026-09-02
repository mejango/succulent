const CHAINS: Record<number, { name: string; slug: string; explorer: string; icon: string }> = {
  1: { name: 'Ethereum', slug: 'eth', explorer: 'etherscan.io', icon: 'mainnet' },
  10: { name: 'Optimism', slug: 'op', explorer: 'optimistic.etherscan.io', icon: 'optimism' },
  8453: { name: 'Base', slug: 'base', explorer: 'basescan.org', icon: 'base' },
  42161: { name: 'Arbitrum', slug: 'arb', explorer: 'arbiscan.io', icon: 'arbitrum' },
  11155111: { name: 'Sepolia', slug: 'sep', explorer: 'sepolia.etherscan.io', icon: 'mainnet' },
  11155420: { name: 'Optimism Sepolia', slug: 'opsep', explorer: 'optimism-sepolia.blockscout.com', icon: 'optimism' },
  84532: { name: 'Base Sepolia', slug: 'basesep', explorer: 'sepolia.basescan.org', icon: 'base' },
  421614: { name: 'Arbitrum Sepolia', slug: 'arbsep', explorer: 'sepolia.arbiscan.io', icon: 'arbitrum' },
}

export function chainName(chainId: number): string {
  return CHAINS[chainId]?.name ?? `Chain ${chainId}`
}

/** The chain's mark as a static asset path, or null for unknown chains. */
export function chainIcon(chainId: number): string | null {
  const icon = CHAINS[chainId]?.icon
  return icon ? `/chains/${icon}.svg` : null
}

export function chainSlug(chainId: number): string {
  return CHAINS[chainId]?.slug ?? String(chainId)
}

export function txUrl(chainId: number, hash: string): string | null {
  const host = CHAINS[chainId]?.explorer
  return host ? `https://${host}/tx/${hash}` : null
}

export function addressUrl(chainId: number, address: string): string | null {
  const host = CHAINS[chainId]?.explorer
  return host ? `https://${host}/address/${address}` : null
}

/** The project's page on juicebox.money, keyed the way that site keys V6 projects. */
export function projectUrl(chainId: number, projectId: number): string {
  return `https://juicebox.money/${CHAINS[chainId]?.slug ?? chainId}:${projectId}`
}
