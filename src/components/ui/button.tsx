'use client'

import * as React from 'react'
import { Loader2 } from '@/components/ui/icons'
import { cn } from '@/lib/utils'

const VARIANTS = {
  default: 'bg-pine text-farina hover:bg-pine/90',
  secondary: 'border border-bloom bg-farina-deep text-pine hover:border-stem',
  outline: 'border border-pine bg-transparent text-pine hover:bg-farina-deep',
  ghost: 'text-pine hover:bg-farina-deep',
  link: 'text-pine underline-offset-4 hover:underline',
} as const
const SIZES = { default: 'h-11 px-4 py-2', sm: 'h-9 px-3', lg: 'h-11 px-8 text-base', icon: 'h-10 w-10' } as const

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean
  size?: keyof typeof SIZES | null
  variant?: keyof typeof VARIANTS | null
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ children, className, disabled, loading, size, variant, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss focus-visible:ring-offset-2 focus-visible:ring-offset-farina disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant ?? 'default'],
        SIZES[size ?? 'default'],
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
      {children}
    </button>
  ),
)
Button.displayName = 'Button'
