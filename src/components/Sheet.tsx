'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { X } from '@/components/ui/icons'

/** A native <dialog> that rises from the bottom edge on phones and centers on wider screens. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
      className="sheet m-0 h-full max-h-none w-full max-w-none bg-transparent p-0 text-pine backdrop:bg-pine/40 open:flex"
    >
      <div className="mt-auto w-full bg-farina px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 sm:m-auto sm:max-w-md sm:border sm:border-bloom sm:pb-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-xl tracking-tight">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="-mr-1 p-1 text-stem hover:text-pine">
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  )
}
