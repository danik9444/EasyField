import { useId, useRef, useState, type ChangeEvent } from 'react'
import { Icon } from '../icons'
import type { ReferenceImage } from '../data/referenceImage'
import { copyLibraryCreationForWorkspace } from '../services/librarySelection'
import { Lightbox } from './Lightbox'
import { LibraryPickerButton } from './LibraryPicker'

interface FrameInputsProps {
  showFirst: boolean
  showLast: boolean
  firstFrame: ReferenceImage | null
  lastFrame: ReferenceImage | null
  locked: boolean
  lockedHint?: string
  fieldLabel?: string
  firstCaption?: string
  lastCaption?: string
  firstGrabLabel?: string
  lastGrabLabel?: string
  variant?: 'default' | 'transition'
  persistentGrab?: boolean
  showGrabText?: boolean
  onPick: (which: 'first' | 'last', file: File) => void
  onGrab: (which: 'first' | 'last') => void
  onClear: (which: 'first' | 'last') => void
}

export function FrameInputs({
  showFirst,
  showLast,
  firstFrame,
  lastFrame,
  locked,
  lockedHint,
  fieldLabel,
  firstCaption = 'FIRST',
  lastCaption = 'LAST',
  firstGrabLabel,
  lastGrabLabel,
  variant = 'default',
  persistentGrab = false,
  showGrabText = false,
  onPick,
  onGrab,
  onClear,
}: FrameInputsProps) {
  const firstInputRef = useRef<HTMLInputElement>(null)
  const lastInputRef = useRef<HTMLInputElement>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const labelId = useId()
  const lockHintId = useId()

  const handleChange = (which: 'first' | 'last') => (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) onPick(which, file)
  }

  const slot = (
    which: 'first' | 'last',
    caption: string,
    image: ReferenceImage | null,
    inputRef: React.RefObject<HTMLInputElement | null>,
    grabLabel?: string,
  ) => (
    <div className="ef-frame-slot">
      <div className="ef-frame-caption-row">
        <span className="ef-frame-caption">{caption}</span>
        <span className="ef-spacer" />
        <LibraryPickerButton
          kinds={['image']}
          max={1}
          disabled={locked}
          onSelect={async ([creation]) => {
            if (!creation) return
            onPick(which, await copyLibraryCreationForWorkspace(creation))
          }}
          className={`ef-grab-btn ef-library-source-btn${showGrabText ? '' : ' icon'}`}
          label={showGrabText ? 'Library' : ''}
          ariaLabel={`Choose ${caption.toLowerCase()} frame from Library`}
          pickerTitle={`Choose ${caption.toLowerCase()} frame`}
          confirmLabel="Use frame"
          iconSize={11}
        />
        {(!image || persistentGrab) && (
          <button
            type="button"
            className={`ef-grab-btn${showGrabText ? '' : ' icon'}`}
            aria-label={grabLabel ?? `Grab current frame as ${caption.toLowerCase()} frame`}
            title={grabLabel ?? 'Grab current timeline frame'}
            disabled={locked}
            onClick={() => onGrab(which)}
          >
            <Icon glyph="playhead" size={11} />
            {showGrabText && <span>Grab</span>}
          </button>
        )}
      </div>
      {image ? (
        <div className="ef-frame-tile">
          {image.kind === 'upload' ? (
            <button
              type="button"
              className="ef-frame-tile-img ef-frame-preview"
              style={{
                background: `#030307 url(${image.url}) center/${variant === 'transition' ? 'contain' : 'cover'} no-repeat`,
              }}
              onClick={() => setPreviewUrl(image.url)}
              aria-label={`Preview ${caption.toLowerCase()} frame`}
              title="View larger"
            />
          ) : (
            <span className="ef-frame-tile-img" />
          )}
          {image.kind === 'playhead' && <span className="ef-frame-badge">⌖</span>}
          <button type="button" className="ef-frame-remove" aria-label={`Remove ${caption.toLowerCase()} frame`} disabled={locked} onClick={() => onClear(which)}>
            ✕
          </button>
        </div>
      ) : (
        <button type="button" className="ef-frame-add" aria-label={`Upload ${caption.toLowerCase()} frame`} title="Upload frame" disabled={locked} onClick={() => inputRef.current?.click()}>
          <Icon glyph="up" size={14} />
        </button>
      )}
      <input ref={inputRef} type="file" accept="image/*" disabled={locked} onChange={handleChange(which)} style={{ display: 'none' }} />
    </div>
  )

  return (
    <div className={`ef-field ef-frame-inputs ef-frame-inputs--${variant}`} role="group" aria-labelledby={labelId} aria-describedby={locked && lockedHint ? lockHintId : undefined}>
      <div className="ef-ref-header">
        <span id={labelId} className="ef-field-label">{fieldLabel ?? (showFirst && showLast ? 'FRAMES' : showLast ? 'LAST FRAME' : 'FIRST FRAME')}</span>
        {locked && lockedHint && (
          <>
            <span className="ef-spacer" />
            <span id={lockHintId} className="ef-lock-hint">{lockedHint}</span>
          </>
        )}
      </div>
      <div className={'ef-frames-row' + (locked ? ' locked' : '')}>
        {showFirst && slot('first', firstCaption, firstFrame, firstInputRef, firstGrabLabel)}
        {showLast && slot('last', lastCaption, lastFrame, lastInputRef, lastGrabLabel)}
      </div>
      {previewUrl && <Lightbox url={previewUrl} onClose={() => setPreviewUrl(null)} />}
    </div>
  )
}
