// Shared reference-image type for any "attach up to N images" flow
// (Create Image, Create Video, and future tools that follow the same pattern).

export type ReferenceImage =
  | { id: string; kind: 'playhead'; timecode: string }
  | {
      id: string
      kind: 'upload'
      name: string
      url: string
      /** Optional source metadata used by provider-specific preflight. */
      mimeType?: string
      byteSize?: number
      width?: number
      height?: number
    }

export const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024
export const SUPPORTED_REFERENCE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

export async function isDecodableReferenceImageFile(file: File): Promise<boolean> {
  if (
    !SUPPORTED_REFERENCE_IMAGE_TYPES.has(file.type)
    || file.size <= 0
    || file.size > MAX_REFERENCE_IMAGE_BYTES
  ) return false
  try {
    const bitmap = await createImageBitmap(file)
    bitmap.close()
    return true
  } catch {
    return false
  }
}

// A video/audio input item (reference clip, driver, continuation, voice).
// Either an uploaded file (owns an object URL) or a clip grabbed from the
// timeline playhead (no URL to revoke).
export type MediaFile =
  | {
      id: string
      kind: 'upload'
      name: string
      url: string
      // Optional preflight metadata. Edit Video records these for Seedance
      // audio so the provider's size/duration limits can be enforced before a
      // paid request; older media callers remain source-compatible.
      mimeType?: string
      byteSize?: number
      durationSeconds?: number
      width?: number
      height?: number
    }
  | { id: string; kind: 'playhead'; name: string; timecode: string }
