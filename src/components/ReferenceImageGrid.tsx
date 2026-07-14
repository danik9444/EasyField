import { useId, useRef, useState, type ChangeEvent } from 'react'
import { Icon } from '../icons'
import type { ReferenceImage } from '../data/referenceImage'
import type { Creation } from '../data/creations'
import { copyLibraryCreationForWorkspace } from '../services/librarySelection'
import { Lightbox } from './Lightbox'
import { LibraryPickerButton } from './LibraryPicker'

interface ReferenceImageGridProps {
  images: ReferenceImage[]
  max: number
  onAddFiles: (files: File[]) => void
  onRemove: (id: string) => void
  onGrabPlayhead?: () => void
  locked?: boolean
  lockedHint?: string
  label?: string
  onChooseLibrary?: (creations: Creation[]) => void | Promise<void>
  libraryExcludedIds?: readonly string[]
}

export function ReferenceImageGrid({ images, max, onAddFiles, onRemove, onGrabPlayhead, locked = false, lockedHint, label = 'REFERENCE IMAGES', onChooseLibrary, libraryExcludedIds }: ReferenceImageGridProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const labelId = useId()
  const hintId = useId()

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length) onAddFiles(files)
  }

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
            {images.length < max && (
              <LibraryPickerButton
                kinds={['image']}
                max={max - images.length}
                onSelect={chooseLibrary}
                className="ef-grab-btn ef-library-source-btn"
                ariaLabel="Choose reference images from Library"
                pickerTitle="Choose reference images"
                confirmLabel="Add references"
                excludedIds={libraryExcludedIds}
              />
            )}
            {onGrabPlayhead && images.length < max && (
              <button type="button" className="ef-grab-btn" onClick={onGrabPlayhead} aria-label="Grab current timeline frame" title="Grab current timeline frame">
                <Icon glyph="playhead" size={12} /> Grab frame
              </button>
            )}
            {max > 1 && <span className="ef-ref-count">{images.length} / {max}</span>}
          </>
        )}
      </div>
      <div className={'ef-ref-grid' + (locked ? ' locked' : '')}>
        {images.map((ref) => (
          <div key={ref.id} className="ef-ref-tile">
            {ref.kind === 'upload' ? (
              <button
                type="button"
                className="ef-ref-tile-img ef-ref-tile-preview"
                style={{ background: `url(${ref.url}) center/cover no-repeat` }}
                onClick={() => setPreviewUrl(ref.url)}
                aria-label={`Preview reference image ${ref.name}`}
                title="View larger"
              />
            ) : (
              <span className="ef-ref-tile-img" />
            )}
            {ref.kind === 'playhead' && <span className="ef-ref-tile-badge">⌖</span>}
            <button
              type="button"
              className="ef-ref-tile-remove"
              aria-label={`Remove reference image ${ref.kind === 'upload' ? ref.name : `from timeline at ${ref.timecode}`}`}
              disabled={locked}
              onClick={() => onRemove(ref.id)}
            >
              ✕
            </button>
          </div>
        ))}
        {images.length < max && (
          <button
            type="button"
            className="ef-ref-add-tile"
            aria-label="Upload reference image"
            title="Upload reference image"
            disabled={locked}
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon glyph="up" size={14} />
          </button>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        disabled={locked}
        onChange={handleChange}
        style={{ display: 'none' }}
      />
      {previewUrl && <Lightbox url={previewUrl} onClose={() => setPreviewUrl(null)} />}
    </div>
  )
}
