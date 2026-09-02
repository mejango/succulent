import { twMerge } from 'tailwind-merge'

/** Join class names and resolve Tailwind conflicts (a caller's `px-0` beats a default `px-4`). */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return twMerge(parts.filter(Boolean).join(' '))
}
