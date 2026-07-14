export interface Settings {
  accent: string
  glow: boolean
  apiKey: string
  windowMode: 'compact' | 'expanded'
  placementMode: 'playhead' | 'replace' | 'append' | 'media-pool'
  /** Legacy persisted field. Pricing is informational and this no longer gates a run. */
  spendLimit: number
  telemetry: boolean
  artifactRoot: string
}

export const ACCENT_OPTIONS = ['#E26BD2', '#5B8CFF', '#3ED598', '#FFB454']
export const SECURE_API_KEY_TOKEN = '__easyfield_secure__'

export const DEFAULT_SETTINGS: Settings = {
  accent: '#E26BD2',
  glow: true,
  apiKey: '',
  windowMode: 'compact',
  placementMode: 'playhead',
  spendLimit: 250,
  telemetry: false,
  artifactRoot: '~/Movies/EasyField',
}

const STORAGE_KEY = 'ef-settings'

const WINDOW_MODES = new Set<Settings['windowMode']>(['compact', 'expanded'])
const PLACEMENT_MODES = new Set<Settings['placementMode']>(['playhead', 'replace', 'append', 'media-pool'])

/**
 * Persisted settings can outlive several app versions (or be edited by a
 * browser extension), so never let an unchecked JSON value reach the UI. The
 * optional base preserves session-only values such as the in-memory API key
 * while merging the Electron state store over the current settings.
 */
export function sanitizeSettings(input: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  if (!input || typeof input !== 'object') return { ...base }
  const value = input as Partial<Record<keyof Settings, unknown>>
  const spendLimit = typeof value.spendLimit === 'number' && Number.isFinite(value.spendLimit)
    ? Math.max(0, Math.round(value.spendLimit))
    : base.spendLimit
  const artifactRoot = typeof value.artifactRoot === 'string' && value.artifactRoot.trim()
    ? value.artifactRoot.trim().slice(0, 4096)
    : base.artifactRoot

  const requestedPlacement = typeof value.placementMode === 'string' && PLACEMENT_MODES.has(value.placementMode as Settings['placementMode'])
    ? value.placementMode as Settings['placementMode']
    : base.placementMode

  return {
    accent: typeof value.accent === 'string' && ACCENT_OPTIONS.includes(value.accent) ? value.accent : base.accent,
    glow: typeof value.glow === 'boolean' ? value.glow : base.glow,
    apiKey: typeof value.apiKey === 'string' ? value.apiKey.slice(0, 8192) : base.apiKey,
    windowMode: typeof value.windowMode === 'string' && WINDOW_MODES.has(value.windowMode as Settings['windowMode'])
      ? value.windowMode as Settings['windowMode']
      : base.windowMode,
    // Replace is destructive and cannot become a default until a real timeline
    // preview + confirmation flow exists. Migrate old persisted selections to
    // the non-destructive playhead behavior instead of silently replacing media.
    placementMode: requestedPlacement === 'replace' ? 'playhead' : requestedPlacement,
    spendLimit,
    telemetry: typeof value.telemetry === 'boolean' ? value.telemetry : base.telemetry,
    artifactRoot,
  }
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    return sanitizeSettings(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: Settings) {
  try {
    const { apiKey: _secret, ...safeSettings } = sanitizeSettings(settings)
    void _secret
    localStorage.setItem(STORAGE_KEY, JSON.stringify(safeSettings))
  } catch {
    // storage unavailable (private mode etc.) — settings stay in-memory
  }
}

// The connected kie.ai key, read fresh from storage at call time (so generation
// always uses the latest key without threading it through every component).
export function currentApiKey(): string {
  return runtimeApiKey.trim()
}

let runtimeApiKey = ''

export function setCurrentApiKey(value: string): void {
  runtimeApiKey = value
}
