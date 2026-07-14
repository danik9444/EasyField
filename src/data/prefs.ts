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

export function loadGenPrefs<PM>(key: string): GenPrefs<PM> {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw ? (JSON.parse(raw) as GenPrefs<PM>) : {}
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
