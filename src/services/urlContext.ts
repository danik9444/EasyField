export interface AnimationUrlContext {
  sourceUrl: string
  finalUrl: string
  title: string
  text: string
  contentType: 'text/html' | 'text/plain' | 'application/xhtml+xml'
  truncated: boolean
}

interface UrlContextResponse {
  ok?: boolean
  context?: unknown
  error?: string
  code?: string
}

export class AnimationUrlContextError extends Error {
  readonly code: string
  readonly status: number

  constructor(message: string, code = 'URL_FETCH_FAILED', status = 0) {
    super(message)
    this.name = 'AnimationUrlContextError'
    this.code = code
    this.status = status
  }
}

function isUrlContext(value: unknown): value is AnimationUrlContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return typeof item.sourceUrl === 'string'
    && typeof item.finalUrl === 'string'
    && typeof item.title === 'string'
    && typeof item.text === 'string'
    && ['text/html', 'text/plain', 'application/xhtml+xml'].includes(String(item.contentType))
    && typeof item.truncated === 'boolean'
    // The URL-context boundary returns text, never executable/raw HTML fields.
    && !Object.hasOwn(item, 'html')
}

/**
 * Resolve an HTTPS website into bounded, backend-sanitized plain text for an
 * Animation prompt. The packaged plugin and Vite dev server expose the same
 * relative endpoint, so callers never fetch arbitrary websites in Chromium.
 */
export async function fetchAnimationUrlContext(
  url: string,
  options: { signal?: AbortSignal } = {},
): Promise<AnimationUrlContext> {
  const response = await fetch('/api/url-context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal: options.signal,
  })

  let payload: UrlContextResponse
  try {
    payload = await response.json() as UrlContextResponse
  } catch {
    throw new AnimationUrlContextError('EasyField could not read the website response.', 'INVALID_RESPONSE', response.status)
  }

  if (!response.ok || payload.ok !== true) {
    throw new AnimationUrlContextError(
      typeof payload.error === 'string' && payload.error ? payload.error : 'EasyField could not read this URL.',
      typeof payload.code === 'string' && payload.code ? payload.code : 'URL_FETCH_FAILED',
      response.status,
    )
  }
  if (!isUrlContext(payload.context)) {
    throw new AnimationUrlContextError('EasyField received an invalid URL-context response.', 'INVALID_RESPONSE', response.status)
  }
  return payload.context
}
