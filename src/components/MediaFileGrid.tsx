import { useId, useRef, type ChangeEvent } from 'react'
import { Icon, type GlyphName } from '../icons'
import type { MediaFile } from '../data/referenceImage'
import type { Creation, CreationKind } from '../data/creations'
import { inferLibraryKindsFromAccept } from '../data/librarySelection'
import { copyLibraryCreationForWorkspace } from '../services/librarySelection'
import { LibraryPickerButton } from './LibraryPicker'

interface MediaFileGridProps {
  label: string
  addLabel: string
  glyph: GlyphName
  accept: string
  items: MediaFile[]
  max: number
  onAddFiles: (files: File[]) => void
  onRemove: (id: string) => void
  onGrabPlayhead?: () => void
  grabLabel?: string
  locked?: boolean
  lockedHint?: string
  onChooseLibrary?: (creations: Creation[]) => void | Promise<void>
  /**
   * Overrides the preview inferred from `accept`. `none` is useful for a
   * file-shaped input that should stay compact even when it accepts media.
   */
  previewKind?: 'video' | 'audio' | 'none'
}

export function MediaFileGrid({
  label,
  addLabel,
  glyph,
  accept,
  items,
  max,
  onAddFiles,
  onRemove,
  onGrabPlayhead,
  grabLabel = 'from timeline',
  locked = false,
  lockedHint,
  onChooseLibrary,
  previewKind,
}: MediaFileGridProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const labelId = useId()
  const hintId = useId()

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length) onAddFiles(files)
  }

  const libraryKinds = inferLibraryKindsFromAccept(accept) as CreationKind[]
  // Only infer a player when this input accepts exactly one playable medium.
  // Mixed accept lists stay as compact file rows unless the caller opts in.
  const inferredPreviewKind = libraryKinds.length === 1 && (libraryKinds[0] === 'video' || libraryKinds[0] === 'audio')
    ? libraryKinds[0]
    : null
  const playableKind = previewKind === 'none' ? null : previewKind ?? inferredPreviewKind
  const chooseLibrary = async (creations: Creation[]) => {
    if (onChooseLibrary) {
      await onChooseLibrary(creations)
      return
    }
    const files = await Promise.all(creations.map((creation) => copyLibraryCreationForWorkspace(creation)))
    onAddFiles(files)
  }

  return (
    <div className="ef-field" role="group" aria-labelledby={labelId} aria-describedby={locked && lockedHint ? hintId : undefined}>
      <div className="ef-ref-header">
        <span id={labelId} className="ef-field-label">{label}</span>
        <span className="ef-spacer" />
        {locked ? (
          lockedHint ? <span id={hintId} className="ef-lock-hint">{lockedHint}</span> : null
        ) : (
          <>
            {libraryKinds.length > 0 && items.length < max && (
              <LibraryPickerButton
                kinds={libraryKinds}
                max={max - items.length}
                onSelect={chooseLibrary}
                className="ef-grab-btn ef-library-source-btn"
                ariaLabel={`Choose ${addLabel} from Library`}
                pickerTitle={`Choose ${addLabel} from Library`}
                confirmLabel={`Add ${addLabel}`}
              />
            )}
            {onGrabPlayhead && items.length < max && (
              <button type="button" className="ef-grab-btn" onClick={onGrabPlayhead} aria-label={`Grab ${addLabel} ${grabLabel}`} title="Grab from timeline">
                <Icon glyph="playhead" size={12} /> Grab
              </button>
            )}
            <span className="ef-ref-count">{items.length} / {max}</span>
          </>
        )}
      </div>
      <div className={'ef-media-list' + (locked ? ' locked' : '')}>
        {items.map((item) => {
          const previewUrl = item.kind === 'upload' ? item.url : null
          const hasPreview = !!previewUrl && !!playableKind
          return (
            <div className={`ef-media-file${hasPreview ? ` has-preview is-${playableKind}` : ''}`} key={item.id}>
              <div className="ef-media-file-summary">
                <span className="ef-media-file-icon">
                  <Icon glyph={item.kind === 'playhead' ? 'playhead' : glyph} size={13} />
                </span>
                <span className="ef-media-file-name" title={item.name}>{item.name}</span>
                <button type="button" className="ef-media-file-remove" aria-label={`Remove ${addLabel} ${item.name}`} disabled={locked} onClick={() => onRemove(item.id)}>
                  ✕
                </button>
              </div>
              {previewUrl && playableKind === 'video' && (
                <div className="ef-media-file-preview is-video">
                  <video src={previewUrl} controls playsInline preload="metadata" aria-label={`Preview ${item.name}`} />
                </div>
              )}
              {previewUrl && playableKind === 'audio' && (
                <div className="ef-media-file-preview is-audio">
                  <audio src={previewUrl} controls preload="metadata" aria-label={`Preview ${item.name}`} />
                </div>
              )}
            </div>
          )
        })}
        {items.length < max && (
          <button type="button" className="ef-media-add" aria-label={`Upload ${addLabel}`} disabled={locked} onClick={() => fileInputRef.current?.click()}>
            <Icon glyph="up" size={12} /> Add {addLabel}
          </button>
        )}
      </div>
      <input ref={fileInputRef} type="file" accept={accept} multiple={max > 1} disabled={locked} onChange={handleChange} style={{ display: 'none' }} />
    </div>
  )
}
