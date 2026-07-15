// Cost estimation from the cloud provider's public pricing feed. Live rows are
// refreshed by App; the local tables are
// dated fallbacks so pricing stays useful offline without blocking generation.
import type { ProviderLivePriceRow } from '../services/providerGateway'
import { topazImageOutputTier, type UpscaleMediaKind } from './upscale.ts'

/**
 * Current upstream base value for one direct-provider credit. This is shown
 * only to accounts with a server-asserted direct-billing capability. Regular
 * EasyField customers are billed and shown exclusively in EasyField credits.
 */
export const DIRECT_PROVIDER_CREDIT_USD = 0.005
/** @deprecated Use DIRECT_PROVIDER_CREDIT_USD for privileged direct billing. */
export const CREDIT_USD = DIRECT_PROVIDER_CREDIT_USD
export const FALLBACK_PRICE_DATE = '2026-07-11'

export type PricingDisplayMode = 'credits-only' | 'credits-and-raw-cost'

export type PriceSource = 'live' | 'fallback' | 'unavailable' | 'local'

export interface Estimate {
  credits: number | null
  perSecond: boolean
  count?: number
  unit?: 'img' | 'clip'
  source?: PriceSource
  minimum?: boolean
}

interface IndexedLivePrice extends ProviderLivePriceRow {
  search: string
}

let LIVE_ROWS: IndexedLivePrice[] = []

const normalise = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim()

/** Install a complete snapshot from the provider's public live pricing table. */
export function applyLivePrices(rows: ProviderLivePriceRow[]): number {
  LIVE_ROWS = rows
    .filter((row) => Number.isFinite(row.credits))
    .map((row) => ({ ...row, search: normalise(row.modelDescription) }))
  return LIVE_ROWS.length
}

function livePrice(tokens: string[], excludes: string[] = []): number | undefined {
  const required = tokens.map(normalise)
  const forbidden = excludes.map(normalise)
  return LIVE_ROWS.find((row) => required.every((token) => row.search.includes(token)) && forbidden.every((token) => !row.search.includes(token)))?.credits
}

function priced(
  live: number | undefined,
  fallback: number,
  options: Omit<Estimate, 'credits' | 'source'> & { multiplier?: number } = { perSecond: false },
): Estimate {
  const multiplier = options.multiplier ?? 1
  return {
    credits: (live ?? fallback) * multiplier,
    perSecond: options.perSecond,
    count: options.count,
    unit: options.unit,
    minimum: options.minimum,
    source: live == null ? 'fallback' : 'live',
  }
}

function unavailable(options: Omit<Estimate, 'credits' | 'source'> = { perSecond: false }): Estimate {
  return { ...options, credits: null, source: 'unavailable' }
}

type ResMap = Record<string, number>

// ---------------------------------------------------------------------------
// Images — credits per output image
// ---------------------------------------------------------------------------

const IMAGE_FALLBACK: Record<string, ResMap | number> = {
  'GPT Image 2': { '1K': 6, '2K': 10, '4K': 16 },
  'Nano Banana Pro': { '1K': 18, '2K': 18, '4K': 24 },
  'Nano Banana 2': { '1K': 8, '2K': 12, '4K': 18 },
  'Nano Banana 2 Lite': 4,
  'Seedream 5 Lite': 5.5,
  'Seedream 4.5': 6.5,
  'Wan 2.7 Image': { '1K': 4.8, '2K': 4.8, '4K': 12 },
  'Qwen2 Image': 5.6,
}

const FLUX_FALLBACK: Record<string, ResMap> = {
  Pro: { '1K': 5, '2K': 7 },
  // The current public table omits Flex rows; retain the latest published
  // values previously captured from its official pricing UI.
  Flex: { '1K': 14, '2K': 24 },
}

export interface ImagePriceContext {
  referenceCount?: number
}

function imageLivePrice(model: string, resolution: string, variant: string, context: ImagePriceContext): number | undefined {
  const res = resolution || '1K'
  switch (model) {
    case 'GPT Image 2':
      return livePrice(['gpt image 2', res])
    case 'Nano Banana Pro':
      return livePrice(['google nano banana pro', res === '4K' ? '4k' : '1/2k'])
    case 'Nano Banana 2':
      return livePrice(['google nano banana 2', res], ['lite', 'pro'])
    case 'Nano Banana 2 Lite':
      return livePrice(['nano-banana-2-lite', '1k'])
    case 'Seedream 5 Pro':
      return livePrice(['seedream 5 pro', context.referenceCount ? 'image-to-image' : 'text-to-image', res])
    case 'Seedream 5 Lite':
      return livePrice(['seedream 5.0 lite'])
    case 'Seedream 4.5':
      return livePrice(['seedream 4.5'])
    case 'Wan 2.7 Image':
      return res === '4K'
        ? livePrice(['wan 2.7 image pro'])
        : livePrice(['wan 2.7 image'], ['pro'])
    case 'Qwen2 Image':
      return livePrice(['qwen2', 'image'])
    case 'Flux 2':
      return variant === 'Pro' ? livePrice(['flux-2 pro', res]) : undefined
    default:
      return undefined
  }
}

export function imageRunEstimate(
  model: string,
  resolution: string,
  extraOptionValues: Record<string, string>,
  count = 1,
  context: ImagePriceContext = {},
): Estimate {
  const variant = extraOptionValues.variant === 'Pro' ? 'Pro' : 'Flex'
  if (model === 'Seedream 5 Pro') {
    const res = resolution || '1K'
    const fallback = res === '2K' ? 14 : 7
    const outputLive = imageLivePrice(model, res, variant, context)
    const extraInputs = Math.max(0, (context.referenceCount ?? 0) - 1)
    const inputLive = extraInputs ? livePrice(['seedream 5 pro', 'input image', 'first image free']) : undefined
    const inputRate = inputLive ?? 0.5
    return {
      credits: ((outputLive ?? fallback) + extraInputs * inputRate) * count,
      perSecond: false,
      count,
      unit: 'img',
      source: outputLive != null && (!extraInputs || inputLive != null) ? 'live' : 'fallback',
    }
  }
  const fallbackEntry = model === 'Flux 2' ? FLUX_FALLBACK[variant] : IMAGE_FALLBACK[model]
  if (fallbackEntry == null) return unavailable({ perSecond: false, count, unit: 'img' })
  const fallback = typeof fallbackEntry === 'number'
    ? fallbackEntry
    : fallbackEntry[resolution] ?? Object.values(fallbackEntry)[0]
  const live = imageLivePrice(model, resolution, variant, context)
  return priced(live, fallback, { perSecond: false, count, unit: 'img', multiplier: count })
}

// ---------------------------------------------------------------------------
// Video generation
// ---------------------------------------------------------------------------

export interface VideoPriceContext {
  hasVideoInput?: boolean
  hasImageInput?: boolean
  referenceMode?: boolean
  /** Exact input clip length for providers that bill by source/driver duration. */
  inputDurationSeconds?: number
}

const VIDEO_RATE_FALLBACK: Record<string, ResMap> = {
  'Seedance 2': { '480p': 19, '720p': 41, '1080p': 102, '4K': 208 },
  'Seedance 2 Fast': { '480p': 15.5, '720p': 33 },
  'Seedance 2 Mini': { '480p': 9.5, '720p': 20.5 },
  'Kling 3 Turbo': { '720p': 18, '1080p': 22.5 },
  'Kling 3 Motion Control': { '720p': 20, '1080p': 27 },
  'Wan 2.7 Video': { '720p': 16, '1080p': 24 },
  'Happy Horse 1.1': { '720p': 22.5, '1080p': 29 },
  'Grok Imagine 1.5 Preview': { '480p': 1.6, '720p': 3 },
  'Grok Imagine Video': { '480p': 1.6, '720p': 3 },
}

const VEO_FALLBACK: Record<string, ResMap> = {
  Quality: { '720p': 250, '1080p': 255, '4K': 380 },
  Fast: { '720p': 60, '1080p': 65, '4K': 180 },
  Lite: { '720p': 30, '1080p': 35, '4K': 150 },
}

const RUNWAY_FALLBACK: Record<string, number> = {
  '720p:5': 12,
  '720p:10': 30,
  '1080p:5': 30,
}

function seedanceName(model: string): string {
  if (model === 'Seedance 2 Fast') return 'bytedance/seedance-2 fast'
  if (model === 'Seedance 2 Mini') return 'bytedance/seedance-2-mini'
  return 'bytedance/seedance-2,'
}

function videoRateLive(model: string, resolution: string, withVideo: boolean): number | undefined {
  switch (model) {
    case 'Seedance 2':
    case 'Seedance 2 Fast':
    case 'Seedance 2 Mini':
      return livePrice([seedanceName(model), resolution, withVideo ? 'with video' : 'no video'])
    case 'Kling 3 Turbo':
      return livePrice(['kling 3.0 turbo', resolution])
    case 'Kling 3 Motion Control':
      return livePrice(['kling 3.0 motion control', resolution])
    case 'Wan 2.7 Video':
      return livePrice(['wan 2.7 video', resolution], ['videoedit'])
    case 'Happy Horse 1.1':
      return livePrice(['happyhorse-1.1', resolution])
    case 'Grok Imagine Video':
      return livePrice(['grok-imagine,', 'video', resolution], ['1-5-preview'])
    case 'Grok Imagine 1.5 Preview':
      return livePrice(['grok-imagine-video-1-5-preview', resolution])
    default:
      return undefined
  }
}

function kling3Rate(resolution: string, audioOn: boolean): { live?: number; fallback: number } {
  const fallback = resolution === '4K' ? 67 : resolution === '1080p' ? (audioOn ? 27 : 18) : (audioOn ? 20 : 14)
  const live = livePrice(['kling 3.0, video', audioOn ? 'with audio' : 'without audio', resolution], ['turbo', 'motion control'])
  return { live, fallback }
}

function geminiOmniFallback(resolution: string, duration: string, withVideo: boolean): number {
  if (withVideo) return resolution === '4K' ? 252 : 168
  const seconds = Number(duration) || 8
  const base = 63 + ((seconds - 4) / 2) * 21
  return resolution === '4K' ? base + 84 : base
}

function geminiOmniLive(resolution: string, duration: string, withVideo: boolean): number | undefined {
  return withVideo
    ? livePrice(['gemini-omni-video', resolution, 'with video input'])
    : livePrice(['gemini-omni-video', `${Number(duration) || 8}s`, resolution, 'no video input'])
}

function veoTier(model: string): 'Quality' | 'Fast' | 'Lite' {
  if (model.endsWith('Fast')) return 'Fast'
  if (model.endsWith('Lite')) return 'Lite'
  return 'Quality'
}

function singleVideoEstimate(
  model: string,
  resolution: string,
  duration: string,
  extraOptionValues: Record<string, string>,
  context: VideoPriceContext,
): Estimate {
  if (model === 'Kling 3') {
    const rate = kling3Rate(resolution, extraOptionValues.audio !== 'Off')
    const seconds = Number(duration)
    return priced(rate.live, rate.fallback, {
      perSecond: !seconds,
      unit: 'clip',
      multiplier: seconds || 1,
    })
  }

  if (model === 'Hailuo 2.3 Pro') {
    const fallback = resolution.toLowerCase() === '1080p' ? 80 : Number(duration) === 10 ? 90 : 45
    const live = livePrice(['hailuo 2.3', 'pro', `${Number(duration) || 6}.0s`, resolution])
    return priced(live, fallback, { perSecond: false, unit: 'clip' })
  }

  if (model === 'Hailuo 2.3 Standard') {
    const seconds = Number(duration) || 6
    const resolutionToken = resolution.toUpperCase() === '1080P' ? '1080p' : '768p'
    const fallback = resolutionToken === '1080p' ? 50 : seconds === 10 ? 50 : 30
    const live = livePrice(['hailuo 2.3', 'standard', `${seconds}.0s`, resolutionToken])
    return priced(live, fallback, { perSecond: false, unit: 'clip' })
  }

  if (model === 'Gemini Omni Video') {
    return priced(
      geminiOmniLive(resolution, duration, !!context.hasVideoInput),
      geminiOmniFallback(resolution, duration, !!context.hasVideoInput),
      { perSecond: false, unit: 'clip' },
    )
  }

  if (model.startsWith('Veo 3.1')) {
    const tier = veoTier(model)
    const inputType = context.referenceMode ? 'reference-to-video' : context.hasImageInput ? 'image-to-video' : 'text-to-video'
    const live = livePrice(['google veo 3.1', inputType, `${tier}-${resolution}`])
    let fallback = VEO_FALLBACK[tier][resolution] ?? Object.values(VEO_FALLBACK[tier])[0]
    // The live table distinguishes only Quality 4K text (380) vs image (370).
    if (tier === 'Quality' && resolution === '4K' && context.hasImageInput) fallback = 370
    return priced(live, fallback, { perSecond: false, unit: 'clip' })
  }

  if (model === 'Runway AI Video') {
    const seconds = Number(duration) || 5
    const mode = context.hasImageInput ? 'image-to-video' : 'text-to-video'
    const live = livePrice(['runway,', mode, `${seconds}.0s-${resolution}`])
    const fallback = RUNWAY_FALLBACK[`${resolution}:${seconds}`] ?? 12
    return priced(live, fallback, { perSecond: false, unit: 'clip' })
  }

  const fallbackRates = VIDEO_RATE_FALLBACK[model]
  if (fallbackRates) {
    const fallback = fallbackRates[resolution] ?? Object.values(fallbackRates)[0]
    const live = videoRateLive(model, resolution, !!context.hasVideoInput)
    const seconds = Number(duration) || (model === 'Kling 3 Motion Control' ? Number(context.inputDurationSeconds) : 0)
    return priced(live, fallback, { perSecond: !seconds, unit: 'clip', multiplier: seconds || 1 })
  }

  return unavailable({ perSecond: false, unit: 'clip' })
}

export function videoRunEstimate(
  model: string,
  resolution: string,
  duration: string,
  extraOptionValues: Record<string, string>,
  count = 1,
  context: VideoPriceContext = {},
): Estimate {
  const one = singleVideoEstimate(model, resolution, duration, extraOptionValues, context)
  return one.credits == null
    ? { ...one, count, unit: 'clip' }
    : { ...one, credits: one.credits * count, count, unit: 'clip' }
}

// ---------------------------------------------------------------------------
// Image editing
// ---------------------------------------------------------------------------

export function imageEditRunEstimate(
  operation: string,
  customModel: string,
  resolution: string,
  extras: Record<string, string>,
  upscaleModel?: string,
  referenceCount = 0,
): Estimate {
  if (operation === 'custom') return imageRunEstimate(customModel, resolution, extras, 1, { referenceCount })
  if (operation === 'removebg') {
    return priced(livePrice(['recraft remove background']), 1, { perSecond: false, unit: 'img' })
  }
  if (operation === 'upscale' && upscaleModel === 'Recraft Crisp Upscale') {
    return priced(livePrice(['recraft crisp upscale']), 0.5, { perSecond: false, unit: 'img' })
  }
  if (operation === 'upscale' && upscaleModel === 'Topaz Image Upscale') {
    // Topaz bills by resulting 2K/4K/8K resolution, which cannot be known from
    // the factor alone before inspecting source dimensions. Show the live 2K
    // minimum; the exact creditsConsumed value replaces it after the run.
    return priced(livePrice(['topaz image upscaler', '2k']), 10, { perSecond: false, unit: 'img', minimum: true })
  }
  if (operation === 'inpaint' && customModel === 'Ideogram V3 Edit') {
    return priced(livePrice(['ideogram v3-edit', 'balanced']), 7, { perSecond: false, unit: 'img' })
  }
  return unavailable({ perSecond: false, unit: 'img' })
}

// ---------------------------------------------------------------------------
// Video editing
// ---------------------------------------------------------------------------

function editDurationSeconds(params: Record<string, string>): number | null {
  const duration = params.duration
  if (!duration || duration === 'Full') return null
  const parsed = parseInt(duration, 10)
  return Number.isFinite(parsed) ? parsed : null
}

export function videoEditRunEstimate(
  operation: string,
  model: string,
  params: Record<string, string>,
  factor: string,
): Estimate {
  if (operation === 'upscale') {
    const fourX = factor === '4×'
    return priced(
      livePrice(['topaz video upscaler', fourX ? '4x' : '1x/2x']),
      fourX ? 14 : 8,
      { perSecond: true, unit: 'clip' },
    )
  }
  if (operation === 'luts') return { credits: 0, perSecond: false, unit: 'clip', source: 'local' }

  if (model === 'Runway Aleph') {
    return priced(livePrice(['runway aleph']), 110, { perSecond: false, unit: 'clip' })
  }

  if (model === 'Gemini Omni Video') {
    const resolution = params.resolution ?? '720p'
    return priced(
      geminiOmniLive(resolution, params.duration ?? '4s', true),
      geminiOmniFallback(resolution, params.duration ?? '4s', true),
      { perSecond: false, unit: 'clip' },
    )
  }

  if (model === 'Seedance 2' || model === 'Seedance 2 Fast' || model === 'Seedance 2 Mini') {
    const resolution = params.resolution ?? '720p'
    const fallback = model === 'Seedance 2 Fast'
      ? ({ '480p': 9, '720p': 20 } as ResMap)[resolution] ?? 20
      : model === 'Seedance 2 Mini'
        ? ({ '480p': 9.5, '720p': 20.5 } as ResMap)[resolution] ?? 20.5
        : ({ '480p': 11.5, '720p': 25, '1080p': 62, '4K': 128 } as ResMap)[resolution] ?? 25
    const live = videoRateLive(model, resolution, true)
    const seconds = editDurationSeconds(params)
    return priced(live, fallback, { perSecond: !seconds, unit: 'clip', multiplier: seconds || 1 })
  }

  if (model === 'Wan 2.7 Video Edit') {
    const resolution = params.resolution ?? '1080p'
    const fallback = resolution === '1080p' ? 24 : 16
    const live = livePrice(['wan 2.7 video', 'videoedit', resolution])
    const seconds = editDurationSeconds(params)
    return priced(live, fallback, { perSecond: !seconds, unit: 'clip', multiplier: seconds || 1 })
  }

  if (model === 'HappyHorse Video Edit') {
    const resolution = params.resolution ?? '1080p'
    const fallback = resolution === '1080p' ? 48 : 28
    const live = livePrice(['happyhorse-1.0', 'video-edit', resolution])
    return priced(live, fallback, { perSecond: true, unit: 'clip' })
  }

  return unavailable({ perSecond: false, unit: 'clip' })
}

export interface UpscalePriceContext {
  width?: number
  height?: number
  durationSeconds?: number
}

export interface UpscaleBatchPriceItem extends UpscalePriceContext {
  kind: UpscaleMediaKind
  factor: string
}

/** Exact Topaz preflight whenever the source metadata makes the billed tier knowable. */
export function upscaleRunEstimate(
  kind: UpscaleMediaKind,
  factor: string,
  context: UpscalePriceContext = {},
): Estimate {
  if (kind === 'image') {
    const hasDimensions = Number(context.width) > 0 && Number(context.height) > 0
    const tier = topazImageOutputTier(context.width, context.height, factor)
    // The public table currently stops at 8K even though the provider accepts
    // output sides up to 20,000 px. Never guess a price above the published tier.
    if (hasDimensions && tier == null) return unavailable({ perSecond: false, unit: 'img' })
    const resolvedTier = tier ?? '2K'
    const fallback = resolvedTier === '8K' ? 40 : resolvedTier === '4K' ? 20 : 10
    return priced(livePrice(['topaz image upscaler', resolvedTier.toLowerCase()]), fallback, {
      perSecond: false,
      unit: 'img',
      minimum: !hasDimensions,
    })
  }

  const fourX = factor === '4×'
  const duration = Number(context.durationSeconds)
  const exactDuration = Number.isFinite(duration) && duration > 0 ? duration : 0
  return priced(
    livePrice(['topaz video upscaler', fourX ? '4x' : '1x/2x']),
    fourX ? 14 : 8,
    {
      perSecond: !exactDuration,
      unit: 'clip',
      multiplier: exactDuration || 1,
    },
  )
}

/**
 * Sum a reviewed Topaz batch only when every child has an exact, comparable
 * estimate. The cloud endpoint accepts one source per task, so unknown duration/tier on one
 * child makes the aggregate unknown rather than turning a mixed rate into a
 * misleading total. Individual item estimates can still be shown in the UI.
 */
export function upscaleBatchEstimate(items: readonly UpscaleBatchPriceItem[]): Estimate {
  if (!items.length) return unavailable({ perSecond: false })
  const estimates = items.map((item) => upscaleRunEstimate(item.kind, item.factor, item))
  if (estimates.some((estimate) => estimate.credits == null || estimate.perSecond)) {
    return unavailable({ perSecond: false, count: items.length })
  }
  return {
    credits: estimates.reduce((sum, estimate) => sum + (estimate.credits ?? 0), 0),
    perSecond: false,
    count: items.length,
    unit: items.every((item) => item.kind === 'image')
      ? 'img'
      : items.every((item) => item.kind === 'video')
        ? 'clip'
        : undefined,
    source: estimates.every((estimate) => estimate.source === 'live') ? 'live' : 'fallback',
  }
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export function ttsRunEstimate(model: string, chars: number): Estimate {
  const lower = model.toLowerCase()
  const dialogue = lower.includes('dialogue')
  const turbo = lower.includes('turbo')
  const live = dialogue
    ? livePrice(['elevenlabs v3', 'text to dialogue'])
    : turbo
      ? livePrice(['elevenlabs text to speech', 'turbo 2.5'])
      : livePrice(['elevenlabs text to speech', 'multilingual v2'])
  const fallback = dialogue ? 14 : turbo ? 6 : 12
  return priced(live, fallback, { perSecond: false, unit: 'clip', multiplier: Math.max(chars, 1) / 1000 })
}

export function musicRunEstimate(_version: string): Estimate {
  return priced(livePrice(['suno, generate music']), 12, { perSecond: false, unit: 'clip' })
}

/** Suno Sounds is billed once per request, independent of an invented duration. */
export function soundEffectsRunEstimate(count = 1): Estimate {
  const requests = Math.max(1, Math.floor(count))
  return priced(livePrice(['suno, generate sounds']), 2.5, {
    perSecond: false,
    unit: 'clip',
    count: requests,
    multiplier: requests,
  })
}

// ---------------------------------------------------------------------------
// Avatar / deterministic lip sync
// ---------------------------------------------------------------------------

export interface AvatarPriceContext {
  /** Audio duration drives the rendered duration for the dedicated avatar APIs. */
  audioDurationSeconds?: number
  /** Wan has no duration field; its output length is frames / FPS. */
  numFrames?: number
  framesPerSecond?: number
  resolution?: string
}

function avatarRate(model: string, resolution: string): { live?: number; fallback: number } | null {
  switch (model) {
    case 'Kling Avatar Pro':
      // The live table currently contains the legacy spelling "Avtar".
      return { live: livePrice(['kling ai avtar', 'pro']), fallback: 16 }
    case 'Kling Avatar Standard':
      return { live: livePrice(['kling ai avtar', 'standard']), fallback: 8 }
    case 'OmniHuman 1.5':
      return { live: livePrice(['omnihuman 1.5']), fallback: 27 }
    case 'InfiniteTalk':
      return {
        live: livePrice(['infinitalk', 'from audio', resolution || '480p']),
        fallback: resolution === '720p' ? 12 : 3,
      }
    case 'Wan 2.2 A14B Speech-to-Video Turbo':
      return {
        live: livePrice(['wan 2.2', 'speech to video', resolution || '480p']),
        fallback: resolution === '720p' ? 24 : resolution === '580p' ? 18 : 12,
      }
    case 'Volcengine Lip Sync':
      return { live: livePrice(['volcengine', 'lip sync']), fallback: 8 }
    default:
      return null
  }
}

/**
 * Dedicated avatar endpoints are billed per rendered second. When source
 * duration is unavailable we show the live/fallback rate instead of inventing
 * a clip length; provider-reported credits remain authoritative after a run.
 */
export function avatarRunEstimate(
  model: string,
  count = 1,
  context: AvatarPriceContext = {},
): Estimate {
  const requests = Math.max(1, Math.floor(count))
  const rate = avatarRate(model, context.resolution ?? '')
  if (!rate) return unavailable({ perSecond: false, count: requests, unit: 'clip' })

  const wanDuration = model === 'Wan 2.2 A14B Speech-to-Video Turbo'
    && Number.isFinite(context.numFrames)
    && Number.isFinite(context.framesPerSecond)
    && (context.framesPerSecond ?? 0) > 0
      ? (context.numFrames ?? 0) / (context.framesPerSecond ?? 1)
      : undefined
  const duration = wanDuration ?? context.audioDurationSeconds
  if (duration == null || !Number.isFinite(duration) || duration <= 0) {
    return {
      credits: rate.live ?? rate.fallback,
      perSecond: true,
      count: requests,
      unit: 'clip',
      source: rate.live == null ? 'fallback' : 'live',
    }
  }
  return priced(rate.live, rate.fallback, {
    perSecond: false,
    count: requests,
    unit: 'clip',
    multiplier: duration * requests,
  })
}

// ---------------------------------------------------------------------------
// Display + post-run accounting
// ---------------------------------------------------------------------------

function fmtCredits(credits: number): string {
  if (Number.isInteger(credits)) return String(credits)
  return credits < 1 ? credits.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') : credits.toFixed(1)
}

function fmtUsd(usd: number): string {
  return `$${usd.toFixed(usd < 0.1 ? 3 : 2)}`
}

export function priceSourceLabel(estimate: Estimate): string {
  if (estimate.source === 'live') return 'LIVE'
  if (estimate.source === 'local') return 'LOCAL'
  if (estimate.source === 'unavailable') return 'PROVIDER BILLING'
  return 'UPDATED 7/11'
}

// Only a provider's creditsConsumed value is an exact post-run charge. Never
// manufacture a duration for a per-second job when the provider omits it.
export function resolveCharged(estimate: Estimate): number | null {
  if (estimate.credits == null || estimate.perSecond) return null
  return estimate.credits
}

export function formatCharged(
  charged: number | null,
  displayMode: PricingDisplayMode = 'credits-only',
): string {
  if (charged == null) return 'Billed to your EasyField Cloud credits'
  const credits = `Charged ${fmtCredits(charged)} cr`
  return displayMode === 'credits-and-raw-cost'
    ? `${credits} · ${fmtUsd(charged * DIRECT_PROVIDER_CREDIT_USD)}`
    : credits
}

export function formatEstimate(
  estimate: Estimate,
  includeSource = true,
  displayMode: PricingDisplayMode = 'credits-only',
): string {
  const source = includeSource ? `${priceSourceLabel(estimate)} · ` : ''
  if (estimate.credits == null) return `${source}exact cost shown after run`
  const countSuffix = estimate.count && estimate.count > 1 && estimate.unit
    ? ` · ${estimate.count} ${estimate.unit}${estimate.count > 1 ? 's' : ''}`
    : ''
  const minimum = estimate.minimum ? 'from ' : '≈ '
  const credits = estimate.perSecond
    ? `${fmtCredits(estimate.credits)} cr/s`
    : `${fmtCredits(estimate.credits)} cr`
  if (displayMode === 'credits-and-raw-cost') {
    const usd = estimate.credits * DIRECT_PROVIDER_CREDIT_USD
    const raw = estimate.perSecond ? `${fmtUsd(usd)}/s` : fmtUsd(usd)
    return `${source}${minimum}${credits} · ${raw}${countSuffix}`
  }
  return `${source}${minimum}${credits}${countSuffix}`
}
