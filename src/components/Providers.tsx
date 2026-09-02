'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as React from 'react'
import { useAccount, useConnect, useConnectors, WagmiProvider } from 'wagmi'
import { IS_DETERMINISTIC_BROWSER, PARA_EMBEDDED_WALLET_ENABLED } from '@/lib/browserEnvironment'
import { wagmiConfig } from '@/lib/wagmi'
import { connectParaSession } from '@/providers/para-bridge'
import { verifyMarkedParaSession } from '@/providers/para-session'
import { ParaAuthContext, type ParaRequest } from '@/providers/ParaAuthContext'
import { ParaConnectionNotice } from '@/providers/ParaConnectionNotice'
import { SignInPlaceholder } from '@/providers/SignInPlaceholder'

const ParaModalHost = React.lazy(() => import('@/providers/ParaModalHost'))

/** Hands a finished Para authentication to wagmi, once, when the sheet closes. */
function ParaConnectionBridge({
  modalOpen,
  onConnected,
  onError,
  sessionVersion,
}: {
  modalOpen: boolean
  onConnected: () => void
  onError: () => void
  sessionVersion: number
}) {
  const { isConnected } = useAccount()
  const connectors = useConnectors()
  const { connectAsync } = useConnect()
  const bridging = React.useRef(false)

  React.useEffect(() => {
    if (IS_DETERMINISTIC_BROWSER || sessionVersion === 0) return
    if (modalOpen || isConnected || bridging.current) return
    bridging.current = true
    void connectParaSession({ connectors, connect: connector => connectAsync({ connector }) })
      .then(connected => {
        if (connected) onConnected()
      })
      .catch(onError)
      .finally(() => {
        bridging.current = false
      })
  }, [connectAsync, connectors, isConnected, modalOpen, onConnected, onError, sessionVersion])

  return null
}

/**
 * wagmi + react-query, plus the Para sign-in host. Para's runtime is ~725 KiB and is never
 * shipped to a visitor who does not sign in: it is warmed on idle (not on metered links) and
 * fetched on click otherwise, with a placeholder painted in the same frame as the click.
 * Ported from eth.shop's provider stack.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } } }),
  )
  const [paraHostLoaded, setParaHostLoaded] = React.useState(false)
  const [paraRequestId, setParaRequestId] = React.useState(0)
  const [paraRequest, setParaRequest] = React.useState<ParaRequest>({ kind: 'auth' })
  const [paraModalOpen, setParaModalOpen] = React.useState(false)
  const [paraSessionVersion, setParaSessionVersion] = React.useState(0)
  const [signInEntry, setSignInEntry] = React.useState('')
  const [paraConnectionError, setParaConnectionError] = React.useState(false)

  React.useEffect(() => {
    if (!PARA_EMBEDDED_WALLET_ENABLED) return
    const link = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
    if (link?.saveData) return
    if (link?.effectiveType && /(^|-)2g$/.test(link.effectiveType)) return
    let cancelled = false
    const warm = () => {
      if (!cancelled) setParaHostLoaded(true)
    }
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback
    const schedule = () => (idle ? idle(warm, { timeout: 4000 }) : window.setTimeout(warm, 1500))
    let handle: number | undefined
    if (document.readyState === 'complete') handle = schedule()
    else window.addEventListener('load', () => (handle = schedule()), { once: true })
    return () => {
      cancelled = true
      if (handle !== undefined) window.clearTimeout(handle)
    }
  }, [])

  React.useEffect(() => {
    if (PARA_EMBEDDED_WALLET_ENABLED) void verifyMarkedParaSession()
  }, [])

  const requestSignIn = React.useCallback(() => {
    if (!PARA_EMBEDDED_WALLET_ENABLED) return
    setParaConnectionError(false)
    setParaHostLoaded(true)
    setParaRequest({ kind: 'auth' })
    setParaRequestId(current => current + 1)
  }, [])
  const markParaSettled = React.useCallback(() => setParaSessionVersion(current => current + 1), [])
  const clearParaConnectionError = React.useCallback(() => setParaConnectionError(false), [])
  const showParaConnectionError = React.useCallback(() => setParaConnectionError(true), [])
  const retryParaConnection = React.useCallback(() => {
    setParaConnectionError(false)
    setParaSessionVersion(current => current + 1)
  }, [])
  const paraAuth = React.useMemo(
    () => ({ enabled: PARA_EMBEDDED_WALLET_ENABLED, modalOpen: paraModalOpen, sessionVersion: paraSessionVersion, requestSignIn }),
    [paraModalOpen, paraSessionVersion, requestSignIn],
  )

  return (
    <WagmiProvider config={wagmiConfig} reconnectOnMount>
      <QueryClientProvider client={queryClient}>
        <ParaAuthContext.Provider value={paraAuth}>
          <ParaConnectionBridge
            modalOpen={paraModalOpen}
            onConnected={clearParaConnectionError}
            onError={showParaConnectionError}
            sessionVersion={paraSessionVersion}
          />
          {children}
          {paraConnectionError ? <ParaConnectionNotice onDismiss={clearParaConnectionError} onRetry={retryParaConnection} /> : null}
          {paraHostLoaded ? (
            <React.Suspense
              fallback={
                paraRequest.kind === 'auth' && paraRequestId > 0 ? (
                  <SignInPlaceholder entry={signInEntry} onEntryChange={setSignInEntry} />
                ) : null
              }
            >
              <ParaModalHost
                requestId={paraRequestId}
                request={paraRequest}
                onOpenChange={setParaModalOpen}
                onSettled={markParaSettled}
                entry={signInEntry}
                onEntryChange={setSignInEntry}
              />
            </React.Suspense>
          ) : null}
        </ParaAuthContext.Provider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
