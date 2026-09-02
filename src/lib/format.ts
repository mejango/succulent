const USD_SCALE = 10n ** 18n

function toNumber(raw: bigint | string, decimals: number): number {
  const value = BigInt(raw)
  const base = 10n ** BigInt(decimals)
  return Number(value / base) + Number(value % base) / Number(base)
}

const LADDER: [number, string][] = [
  [1_000_000_000, 'b'],
  [1_000_000, 'm'],
  [1_000, 'k'],
]

/** Compact 18-decimal project-token counts: 1.2k, 34m, 5b. */
export function formatCompactTokenAmount(raw: bigint | string): string {
  try {
    const value = toNumber(raw, 18)
    if (!Number.isFinite(value)) return '—'
    for (const [unit, suffix] of LADDER) {
      if (value >= unit) {
        return `${(value / unit).toFixed(value >= unit * 10 ? 0 : 1).replace(/\.0$/, '')}${suffix}`
      }
    }
    if (value >= 1) {
      return value === Math.round(value)
        ? value.toLocaleString('en-US', { maximumFractionDigits: 0 })
        : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    }
    if (value >= 0.0001) return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
    return value === 0 ? '0' : '<0.0001'
  } catch {
    return '—'
  }
}

/** Accounting-token amounts in their own decimals, four significant fraction digits. */
export function formatTokenAmount(raw: bigint | string, decimals: number): string {
  const value = toNumber(raw, decimals)
  if (value === 0) return '0'
  if (value < 0.0001) return '<0.0001'
  return value.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

/** Bendystraw's USD figures are 18-decimal fixed point. Cents up to $1,000, whole dollars above. */
export function formatUsd18(raw: bigint | string): string {
  try {
    const value = BigInt(raw)
    if (value > 0n && value < USD_SCALE / 100n) return '<$0.01'
    const cents = (value * 100n + USD_SCALE / 2n) / USD_SCALE
    const dollars = cents / 100n
    if (dollars >= 1_000n) return `$${((value + USD_SCALE / 2n) / USD_SCALE).toLocaleString('en-US')}`
    return `$${dollars.toLocaleString('en-US')}.${(cents % 100n).toString().padStart(2, '0')}`
  } catch {
    return '—'
  }
}

export function timeAgo(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor(now / 1000) - timestamp)
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

export function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

const SAFE_RASTER_DATA_IMAGE =
  /^data:image\/(?:avif|bmp|gif|jpe?g|png|webp);base64,[A-Za-z\d+/]+={0,2}$/i

function ipfsGatewayUrl(uri: string): string | null {
  const segments = uri.replace(/^ipfs:\/\//i, '').split('/')
  if (
    segments.length > 8 ||
    segments.some(segment => !/^[A-Za-z\d._~-]{1,128}$/.test(segment) || segment === '.' || segment === '..')
  ) {
    return null
  }
  return `https://juicebox.center/ipfs/${segments.map(encodeURIComponent).join('/')}`
}

/**
 * Resolve an untrusted project logo: raster data URIs and IPFS paths only.
 * Any other scheme (javascript:, blob:, inline SVG) renders the initial tile instead.
 */
export function projectLogoUrl(uri: string | null | undefined): string | null {
  const value = uri?.trim()
  if (!value || value.length > 1_000_000) return null
  if (SAFE_RASTER_DATA_IMAGE.test(value)) return value
  if (/^ipfs:\/\//i.test(value)) return ipfsGatewayUrl(value)
  if (!/^[a-z][a-z\d+.-]*:/i.test(value) && !value.startsWith('//')) return ipfsGatewayUrl(value)
  return null
}
