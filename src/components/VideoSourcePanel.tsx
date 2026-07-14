import { useRef, type ChangeEvent } from 'react'
import { Icon } from '../icons'
import type { MediaFile } from '../data/referenceImage'
import type { Creation } from '../data/creations'
import { copyLibraryCreationForWorkspace } from '../services/librarySelection'
import { LibraryPickerButton } from './LibraryPicker'

interface VideoSourcePanelProps {
  source: MediaFile | null
  onPick: (file: File) => void
  onGrab: () => void
  grabPending?: boolean
  disabled?: boolean
  title?: string
  description?: string
  groupLabel?: string
  uploadLabel?: string
  grabLabel?: string
  onChooseLibrary?: (creation: Creation) => void | Promise<void>
}

// The source clip for Edit Video. Auto-sampled from the playhead on open; the
// user can grab the current timeline clip again or upload a different video.
export function VideoSourcePanel({
  source,
  onPick,
  onGrab,
  grabPending = false,
  disabled = false,
  title = 'Choose a video to edit',
  description = 'Upload a clip, or capture its exact trimmed range under the Resolve playhead.',
  groupLabel = 'Choose the primary video to edit',
  uploadLabel = 'Upload video',
  grabLabel = 'Grab from timeline',
  onChooseLibrary,
}: VideoSourcePanelProps) {
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) onPick(file)
  }

  const chooseLibrary = async ([creation]: Creation[]) => {
    if (!creation) return
    if (onChooseLibrary) await onChooseLibrary(creation)
    else onPick(await copyLibraryCreationForWorkspace(creation))
  }

  return (
    <div className="ef-video-source" aria-busy={grabPending}>
      {source?.kind === 'upload' ? (
        <video className="ef-video-source-media" src={source.url} controls playsInline preload="metadata" />
      ) : (
        <div className="ef-video-source-bg playhead">
          {source?.kind === 'playhead' && (
            <>
              <span className="ef-video-source-play"><Icon glyph="vid" size={22} /></span>
              <span className="ef-video-source-tc">{source.timecode}</span>
            </>
          )}
          {!source && (
            <div className="ef-edit-canvas-empty" role="group" aria-label={groupLabel}>
              <span className="ef-edit-canvas-empty-icon"><Icon glyph="vid" size={20} /></span>
              <strong>{title}</strong>
              <span>{description}</span>
              <div className="ef-edit-canvas-empty-actions">
                <button type="button" className="ef-canvas-btn" disabled={disabled || grabPending} onClick={() => fileRef.current?.click()}>
                  <Icon glyph="up" size={12} /> {uploadLabel}
                </button>
                <LibraryPickerButton
                  kinds={['video']}
                  max={1}
                  disabled={disabled || grabPending}
                  onSelect={chooseLibrary}
                  className="ef-canvas-btn ef-library-source-btn"
                  ariaLabel="Choose primary video from Library"
                  pickerTitle="Choose a video to edit"
                  confirmLabel="Use video"
                />
                <button
                  type="button"
                  className="ef-canvas-btn ef-canvas-btn--grab"
                  disabled={disabled || grabPending}
                  onClick={onGrab}
                  aria-label="Grab the exact trimmed video clip under the Resolve playhead"
                >
                  <Icon glyph="playhead" size={12} /> {grabPending ? 'Grabbing…' : grabLabel}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {source && (
        <div className="ef-edit-canvas-toolbar">
          <LibraryPickerButton
            kinds={['video']}
            max={1}
            disabled={disabled || grabPending}
            onSelect={chooseLibrary}
            className="ef-canvas-btn ef-library-source-btn"
            ariaLabel="Replace primary video from Library"
            pickerTitle="Replace with a Library video"
            confirmLabel="Use video"
          />
          <button
            type="button"
            className="ef-canvas-btn ef-canvas-btn--grab"
            disabled={disabled || grabPending}
            aria-label="Replace with the exact trimmed video clip under the Resolve playhead"
            onClick={onGrab}
          >
            <Icon glyph="playhead" size={11} /> {grabPending ? 'Grabbing…' : 'Grab'}
          </button>
          <button type="button" className="ef-canvas-btn" disabled={disabled || grabPending} aria-label="Change video" onClick={() => fileRef.current?.click()}>Change</button>
        </div>
      )}

      <input ref={fileRef} type="file" accept="video/*" disabled={disabled || grabPending} onChange={handleFile} style={{ display: 'none' }} />
    </div>
  )
}
