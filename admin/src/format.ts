/**
 * Display helpers for integer micro-units.
 *
 * Both scales are 1_000_000 to one unit (MONEY_MICROS_PER_USD and
 * CREDIT_MICROS_PER_CREDIT in src/data/subscriptions.ts). The database emits
 * these as strings so a bigint cannot be truncated in transit; parsing them
 * back through Number is only safe below 2^53, which every realistic balance is,
 * but the guard stays because a silently wrong balance is the worst kind.
 */

const MICROS_PER_UNIT = 1_000_000

function parseMicros(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null
  if (!/^-?[0-9]{1,15}$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/** Renders a micro amount as a decimal unit value, or an em dash when unusable. */
export function formatUnits(value: string | number | null | undefined, fractionDigits = 2): string {
  const micros = parseMicros(value)
  if (micros === null) return '—'
  return (micros / MICROS_PER_UNIT).toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })
}

export function formatMoney(value: string | number | null | undefined): string {
  const micros = parseMicros(value)
  if (micros === null) return '—'
  return `$${formatUnits(value)}`
}

/** Credits read better without cents; they are whole units in practice. */
export function formatCredits(value: string | number | null | undefined): string {
  const micros = parseMicros(value)
  if (micros === null) return '—'
  return formatUnits(value, micros % MICROS_PER_UNIT === 0 ? 0 : 2)
}

export function formatCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return value.toLocaleString('en-US')
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Relative age for the freshness indicator. */
export function formatAge(timestamp: number | null): string {
  if (timestamp === null) return 'never'
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

export function shortId(value: string | null | undefined): string {
  if (!value) return '—'
  return value.length <= 12 ? value : `${value.slice(0, 8)}…`
}
