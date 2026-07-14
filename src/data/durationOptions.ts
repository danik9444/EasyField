export function uniqueDurationOptions(options: readonly string[]): string[] {
  return Array.from(new Set(options.filter(Boolean)))
}

export function durationOptionIndex(options: readonly string[], value: string): number {
  const index = options.indexOf(value)
  return index >= 0 ? index : 0
}

export function durationOptionAt(options: readonly string[], index: number): string | undefined {
  if (options.length === 0) return undefined
  const safeIndex = Math.min(options.length - 1, Math.max(0, Math.round(index)))
  return options[safeIndex]
}

export function formatDurationValue(value: string): string {
  const normalized = value.trim()
  if (/^full$/i.test(normalized)) return 'Full source'
  const seconds = normalized.match(/^(\d+(?:\.\d+)?)s?$/i)
  return seconds ? `${seconds[1]}s` : normalized
}

export function formatDurationAriaValue(value: string): string {
  const normalized = value.trim()
  if (/^full$/i.test(normalized)) return 'Full source duration'
  const seconds = normalized.match(/^(\d+(?:\.\d+)?)s?$/i)
  if (!seconds) return normalized
  return `${seconds[1]} ${seconds[1] === '1' ? 'second' : 'seconds'}`
}
