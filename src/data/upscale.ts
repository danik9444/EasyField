export type UpscaleMediaKind = 'image' | 'video'

export const TOPAZ_IMAGE_MODEL = 'Topaz Image Upscale'
export const TOPAZ_VIDEO_MODEL = 'Topaz Video Upscale'

export const TOPAZ_IMAGE_FACTORS = ['1×', '2×', '4×', '8×'] as const
export const TOPAZ_VIDEO_FACTORS = ['1×', '2×', '4×'] as const

export const TOPAZ_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const TOPAZ_VIDEO_MAX_BYTES = 50 * 1024 * 1024
export const TOPAZ_IMAGE_MAX_OUTPUT_SIDE = 20_000

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const VIDEO_MIMES = new Set(['video/mp4', 'video/quicktime', 'video/x-matroska', 'application/x-matroska'])

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'mkv'])

export interface TopazFileLike {
  name: string
  type?: string
  size: number
}

export interface ValidatedTopazSource {
  kind: UpscaleMediaKind
  mimeType: string
  byteSize: number
}

function extension(name: string): string {
  return name.split('.').pop()?.toLowerCase().trim() ?? ''
}

function normalizedMime(value?: string): string {
  return (value ?? '').split(';', 1)[0].trim().toLowerCase()
}

export function factorNumber(factor: string): number {
  const value = Number(factor.replace(/[×x]/gi, '').trim())
  return Number.isFinite(value) && value > 0 ? value : 0
}

export function topazModelForKind(kind: UpscaleMediaKind): string {
  return kind === 'image' ? TOPAZ_IMAGE_MODEL : TOPAZ_VIDEO_MODEL
}

export function inferTopazSourceKind(file: Pick<TopazFileLike, 'name' | 'type'>): UpscaleMediaKind | null {
  const mime = normalizedMime(file.type)
  if (IMAGE_MIMES.has(mime)) return 'image'
  if (VIDEO_MIMES.has(mime)) return 'video'
  const ext = extension(file.name)
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  return null
}

export function validateTopazSource(
  file: TopazFileLike,
  expectedKind?: UpscaleMediaKind,
): ValidatedTopazSource {
  const mime = normalizedMime(file.type)
  const declaredKind: UpscaleMediaKind | null = mime.startsWith('image/')
    ? 'image'
    : mime.startsWith('video/')
      ? 'video'
      : null
  const inferredKind = inferTopazSourceKind(file)
  if (expectedKind && inferredKind && inferredKind !== expectedKind) {
    throw new Error(`The selected ${expectedKind} contains ${inferredKind} media.`)
  }
  if (expectedKind && !inferredKind && declaredKind && declaredKind !== expectedKind) {
    throw new Error(`The selected ${expectedKind} contains ${declaredKind} media.`)
  }
  const kind = inferredKind ?? expectedKind ?? declaredKind ?? null
  if (!kind) throw new Error('Topaz accepts JPG, PNG, WEBP, MP4, MOV or MKV media.')
  if (!Number.isFinite(file.size) || file.size <= 0) throw new Error('The selected source contains no media bytes.')

  const ext = extension(file.name)
  if (kind === 'image') {
    if ((!IMAGE_MIMES.has(mime) && !IMAGE_EXTENSIONS.has(ext)) || file.size > TOPAZ_IMAGE_MAX_BYTES) {
      if (file.size > TOPAZ_IMAGE_MAX_BYTES) throw new Error('Topaz images must be 10 MB or smaller.')
      throw new Error('Topaz image upscale accepts JPG, PNG or WEBP.')
    }
    const mimeType = IMAGE_MIMES.has(mime)
      ? mime
      : ext === 'png'
        ? 'image/png'
        : ext === 'webp'
          ? 'image/webp'
          : 'image/jpeg'
    return { kind, mimeType, byteSize: file.size }
  }

  if ((!VIDEO_MIMES.has(mime) && !VIDEO_EXTENSIONS.has(ext)) || file.size > TOPAZ_VIDEO_MAX_BYTES) {
    if (file.size > TOPAZ_VIDEO_MAX_BYTES) throw new Error('Topaz videos must be 50 MB or smaller.')
    throw new Error('Topaz video upscale accepts MP4, MOV or MKV.')
  }
  const mimeType = VIDEO_MIMES.has(mime)
    ? mime
    : ext === 'mov'
      ? 'video/quicktime'
      : ext === 'mkv'
        ? 'video/x-matroska'
        : 'video/mp4'
  return { kind, mimeType, byteSize: file.size }
}

export function topazFactorsForSource(
  kind: UpscaleMediaKind,
  width?: number,
  height?: number,
): string[] {
  if (kind === 'video') return [...TOPAZ_VIDEO_FACTORS]
  const longest = Math.max(Number(width) || 0, Number(height) || 0)
  if (!longest) return [...TOPAZ_IMAGE_FACTORS]
  return TOPAZ_IMAGE_FACTORS.filter((factor) => longest * factorNumber(factor) <= TOPAZ_IMAGE_MAX_OUTPUT_SIDE)
}

export type TopazImagePriceTier = '2K' | '4K' | '8K'

export function topazImageOutputTier(
  width: number | undefined,
  height: number | undefined,
  factor: string,
): TopazImagePriceTier | null {
  const longest = Math.max(Number(width) || 0, Number(height) || 0)
  const multiplier = factorNumber(factor)
  if (!longest || !multiplier) return null
  const outputSide = longest * multiplier
  if (outputSide <= 2_048) return '2K'
  if (outputSide <= 4_096) return '4K'
  if (outputSide <= 8_192) return '8K'
  return null
}

export function topazUploadName(kind: UpscaleMediaKind, mimeType: string): string {
  if (kind === 'image') {
    const ext = mimeType === 'image/webp' ? 'webp' : mimeType === 'image/jpeg' ? 'jpg' : 'png'
    return `easyfield-upscale-source.${ext}`
  }
  const ext = mimeType === 'video/quicktime' ? 'mov' : mimeType.includes('matroska') ? 'mkv' : 'mp4'
  return `easyfield-upscale-source.${ext}`
}
