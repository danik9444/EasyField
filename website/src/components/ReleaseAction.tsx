import { ArrowUpRight, Download, Radio } from 'lucide-react'
import type { Locale } from '@/content'
import { copy } from '@/content'
import type { useRelease } from '@/hooks/useRelease'

type ReleaseState = ReturnType<typeof useRelease>

interface ReleaseActionProps {
  locale: Locale
  release: ReleaseState
  compact?: boolean
  className?: string
}

export function ReleaseAction({ locale, release, compact = false, className = '' }: ReleaseActionProps) {
  const text = copy[locale].release
  const available = release.status === 'available'
  const checking = release.status === 'checking'
  const label = checking ? text.checking : available ? text.available : compact ? text.unavailableShort : text.unavailable
  const hint = available ? text.hintAvailable : text.hintUnavailable

  return (
    <a
      className={`release-action ${available ? 'is-available' : 'is-pending'} ${compact ? 'is-compact' : ''} ${className}`.trim()}
      href={release.url}
      target="_blank"
      rel="noreferrer"
      aria-label={`${label}. ${hint}`}
    >
      <span className="release-action-icon" aria-hidden="true">
        {available ? <Download /> : <Radio />}
      </span>
      <span className="release-action-copy">
        <strong>{label}</strong>
        {!compact && <small>{hint}</small>}
      </span>
      {available && release.version && !compact && <span className="release-version">v{release.version}</span>}
      <ArrowUpRight className="release-action-arrow" aria-hidden="true" />
    </a>
  )
}

export default ReleaseAction
