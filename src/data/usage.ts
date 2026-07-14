// Credit balance shown in the panel header. In production this is read from
// kie.ai (Get Remaining Credits — docs.kie.ai/common-api/get-account-credits)
// and re-read after each job; here it persists locally and is decremented by
// the actual `creditsConsumed` a job reports.
import { loadValue, saveValue } from './prefs'

const CREDITS_KEY = 'credits'
const DEFAULT_CREDITS = 128400

export function loadCredits(): number {
  const raw = loadValue(CREDITS_KEY)
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CREDITS
}

export function saveCredits(n: number): void {
  saveValue(CREDITS_KEY, String(Math.max(0, Math.round(n))))
}

// Always "<thousands>.<2 decimals>K" — e.g. 7350 → "7.35K", 128400 → "128.40K".
export function formatTokens(n: number): string {
  return `${(n / 1000).toFixed(2)}K`
}
