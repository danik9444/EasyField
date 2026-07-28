interface BrandMarkProps {
  compact?: boolean
  className?: string
}

export function BrandMark({ compact = false, className = '' }: BrandMarkProps) {
  return (
    <span className={`brand-lockup ${compact ? 'is-compact' : ''} ${className}`.trim()} aria-label="EasyField">
      <svg className="brand-symbol" viewBox="0 0 40 40" aria-hidden="true">
        <defs>
          <linearGradient id="ef-brand-gradient" x1="4" y1="5" x2="37" y2="36" gradientUnits="userSpaceOnUse">
            <stop stopColor="#6F95FF" />
            <stop offset=".47" stopColor="#A878FF" />
            <stop offset="1" stopColor="#E26BD2" />
          </linearGradient>
        </defs>
        <rect width="40" height="40" rx="11" fill="url(#ef-brand-gradient)" />
        <path d="M20 8.5c.7 6.8 4.7 10.8 11.5 11.5-6.8.7-10.8 4.7-11.5 11.5C19.3 24.7 15.3 20.7 8.5 20 15.3 19.3 19.3 15.3 20 8.5Z" fill="#0B0B11" />
        <circle cx="30.3" cy="10.3" r="1.7" fill="#0B0B11" fillOpacity=".7" />
      </svg>
      {!compact && <span className="brand-word">EasyField</span>}
    </span>
  )
}

export default BrandMark
