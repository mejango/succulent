'use client'

import { createJBCenterRpcProvider, JBCENTER_DEFAULT_URL, type JBCenterRpcProvider } from '@bananapus/nana-sdk-core/jbcenter'
import { custom, type Transport } from 'viem'

const BLOCK_LAG_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 2_000]

/** Center's upstreams can pin a block the node has not indexed yet; -32001 is that lag, not a failure. */
function isBehindHead(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === -32001
}

function retryWhileBehindHead(provider: JBCenterRpcProvider, delaysMs = BLOCK_LAG_RETRY_DELAYS_MS): JBCenterRpcProvider {
  return {
    async request(request) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await provider.request(request)
        } catch (error) {
          if (attempt >= delaysMs.length || !isBehindHead(error)) throw error
          await new Promise(resolve => setTimeout(resolve, delaysMs[attempt]))
        }
      }
    },
  }
}

const SITE_ORIGIN = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://succulent.money'

/** Server-side reads carry the site's Origin, which is what Center allowlists; browsers send their own. */
const serverFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers)
  headers.set('Origin', SITE_ORIGIN)
  return fetch(input, { ...init, headers })
}

/** juicebox.center's RPC for a chain, the same transport juicebox.money uses. */
export function jbCenterRpcTransport(chainId: number, timeoutMs = 15_000): Transport {
  return custom(
    retryWhileBehindHead(
      createJBCenterRpcProvider(chainId, {
        baseUrl: JBCENTER_DEFAULT_URL,
        fetch: typeof window === 'undefined' ? serverFetch : (input, init) => window.fetch(input, init),
        timeoutMs,
      }),
    ),
  )
}
