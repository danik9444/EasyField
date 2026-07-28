// Persisted generation settings (localStorage) so the last-used configuration is
// restored when re-entering a screen, and each model remembers its own settings.
// Only scalar settings are persisted — uploaded media (reference images/videos/
// audio) is ephemeral and re-seeds from the playhead on each visit.

const PREFIX = 'ef-prefs-'

export interface GenPrefs<PM> {
  model?: string
  style?: string
  prompt?: string
  count?: string
  perModel?: Record<string, PM>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function loadGenPrefs<PM>(key: string, sanitizePerModel?: (value: unknown) => PM | null): GenPrefs<PM> {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return {}
    const prefs: GenPrefs<PM> = {}
    if (typeof parsed.model === 'string') prefs.model = parsed.model
    if (typeof parsed.style === 'string') prefs.style = parsed.style
    if (typeof parsed.prompt === 'string') prefs.prompt = parsed.prompt
    if (typeof parsed.count === 'string') prefs.count = parsed.count
    if (isRecord(parsed.perModel)) {
      const perModel: Record<string, PM> = {}
      for (const [model, value] of Object.entries(parsed.perModel)) {
        const sanitized = sanitizePerModel ? sanitizePerModel(value) : isRecord(value) ? value as PM : null
        if (sanitized !== null) perModel[model] = sanitized
      }
      if (Object.keys(perModel).length) prefs.perModel = perModel
    }
    return prefs
  } catch {
    return {}
  }
}

export function saveGenPrefs<PM>(key: string, prefs: GenPrefs<PM>): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(prefs))
  } catch {
    // storage unavailable — settings stay in-memory for the session
  }
}

// Simple scalar preference (e.g. a remembered model selection).
export function loadValue(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key)
  } catch {
    return null
  }
}

export function saveValue(key: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + key, value)
  } catch {
    // storage unavailable
  }
}
