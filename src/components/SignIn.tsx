'use client'

import { useState } from 'react'
import { useAccount, useConfig, useConnect, useDisconnect } from 'wagmi'
import { getConnections } from 'wagmi/actions'
import { truncateAddress } from '@/lib/format'
import { failureReason } from '@/lib/tx'
import { logoutParaSession } from '@/providers/para-logout'
import { useParaAuth } from '@/providers/ParaAuthContext'
import { preloadParaHost } from '@/providers/preload-para'

const primary = 'w-full bg-pine px-4 py-3 text-[15px] font-medium text-farina disabled:opacity-40'

/**
 * The way in: Para's sheet (email, phone, socials, wallets) when a Para key is configured,
 * the browser's injected wallet otherwise, so local builds without keys still work.
 */
export function SignIn({ label = 'Sign in', onOpen }: { label?: string; /** Fired as the Para sheet is requested, so a host sheet can step aside. */ onOpen?: () => void }) {
  const { enabled, requestSignIn } = useParaAuth()
  const { connectors, connect, isPending, error } = useConnect()
  if (enabled) {
    return (
      <div className="space-y-2">
        <button
          type="button"
          className={primary}
          onMouseEnter={preloadParaHost}
          onFocus={preloadParaHost}
          onTouchStart={preloadParaHost}
          onClick={() => {
            onOpen?.()
            requestSignIn()
          }}
        >
          {label}
        </button>
      </div>
    )
  }
  const connector = connectors.find(entry => entry.id !== 'para')
  return (
    <div className="space-y-2">
      <button type="button" className={primary} disabled={!connector || isPending} onClick={() => connector && connect({ connector })}>
        {isPending ? 'Signing in' : label}
      </button>
      {error ? <p className="text-[13px] text-rose">{failureReason(error)}</p> : null}
    </div>
  )
}

/** "from 0x… · sign out": ends Para's session first when one exists, then wagmi's. */
export function SignedInAs() {
  const { address } = useAccount()
  const config = useConfig()
  const { disconnectAsync } = useDisconnect()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  if (!address) return null

  const signOut = async () => {
    setPending(true)
    setError(null)
    try {
      const { getParaClient } = await import('@/providers/para-config')
      const paraSession = await getParaClient().isFullyLoggedIn().catch(() => false)
      if (paraSession) {
        await logoutParaSession({ disconnect: disconnectAsync })
        return
      }
      try {
        await disconnectAsync()
      } catch (caught) {
        const live = getConnections(config)
        if (!live.length) throw caught
        for (const connection of live) await disconnectAsync({ connector: connection.connector })
      }
    } catch (caught) {
      setError(failureReason(caught))
    } finally {
      setPending(false)
    }
  }

  return (
    <p className="flex items-center gap-3 font-mono text-[11px] text-stem">
      {/* The account is a toggle; sign out shows only once it is tapped. */}
      <button type="button" onClick={() => setOpen(current => !current)} title={address} aria-expanded={open} className="underline-offset-2 hover:underline">
        {truncateAddress(address)}
      </button>
      {open ? (
        <button type="button" onClick={signOut} disabled={pending} className="text-pine underline-offset-2 hover:underline disabled:opacity-50">
          {pending ? 'signing out' : 'sign out'}
        </button>
      ) : null}
      {error ? <span className="text-rose">{error}</span> : null}
    </p>
  )
}
