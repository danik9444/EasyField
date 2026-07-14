/**
 * Provider prompt limits are measured as Unicode code points so an emoji or
 * other supplementary-plane character counts as one user-visible character,
 * rather than two UTF-16 code units.
 */
export function promptCharacterCount(value: string): number {
  return Array.from(value).length
}

/** Keep at most `maximum` Unicode code points without splitting a surrogate pair. */
export function truncatePrompt(value: string, maximum: number): string {
  if (!Number.isFinite(maximum) || maximum < 0) throw new Error('Prompt maximum must be a non-negative number.')
  return Array.from(value).slice(0, Math.floor(maximum)).join('')
}

/**
 * Cloud schemas that do not publish a prompt maximum still need a bounded
 * request contract. This intentionally conservative ceiling is surfaced in
 * the UI as an unpublished-provider fallback, not presented as a model limit.
 */
export const PROVIDER_UNPUBLISHED_PROMPT_MAX = 800

export const HAPPY_HORSE_PROMPT_MAX = 4_999
export const HAPPY_HORSE_CJK_PROMPT_MAX = 2_500

/** The Happy Horse contract applies a lower ceiling to CJK prompts. */
export function happyHorsePromptMax(value: string): number {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)
    ? HAPPY_HORSE_CJK_PROMPT_MAX
    : HAPPY_HORSE_PROMPT_MAX
}

export function assertPromptCharacterLimit(
  value: string,
  maximum: number,
  label = 'Prompt',
  minimum = 0,
): void {
  const length = promptCharacterCount(value)
  const meaningfulLength = promptCharacterCount(value.trim())
  if (meaningfulLength < minimum || length > maximum) {
    if (minimum > 0) {
      throw new Error(`${label} must be ${minimum.toLocaleString()}–${maximum.toLocaleString()} characters.`)
    }
    throw new Error(`${label} must be ${maximum.toLocaleString()} characters or fewer.`)
  }
}
