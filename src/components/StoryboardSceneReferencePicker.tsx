import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Creation } from '../data/creations'
import type { ReferenceImage } from '../data/referenceImage'
import { Icon } from '../icons'
import { ReferenceImageGrid } from './ReferenceImageGrid'

const FOCUSABLE = 'button:not(:disabled),input:not(:disabled),[tabindex]:not([tabindex="-1"])'

interface StoryboardReferencePickerProps {
  open: boolean
  scope?: 'scene' | 'story' | 'continuity' | 'image'
  continuityRole?: 'previous' | 'next'
  sceneLabel: string
  images: ReferenceImage[]
  max: number
  locked?: boolean
  lockedHint?: string
  onAddFiles: (files: File[]) => void
  onChooseLibrary?: (creations: Creation[]) => void | Promise<void>
  onGrabPlayhead: () => void
  onRemove: (referenceId: string) => void
  onClose: () => void
  libraryExcludedIds?: readonly string[]
}

export function StoryboardReferencePicker({
  open,
  scope = 'scene',
  continuityRole,
  sceneLabel,
  images,
  max,
  locked = false,
  lockedHint,
  onAddFiles,
  onChooseLibrary,
  onGrabPlayhead,
  onRemove,
  onClose,
  libraryExcludedIds,
}: StoryboardReferencePickerProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => closeRef.current?.focus())
    return () => {
      cancelAnimationFrame(frame)
      previousFocus?.focus()
    }
  }, [open])

  if (!open || typeof document === 'undefined') return null

  const isStoryScope = scope === 'story'
  const isContinuityScope = scope === 'continuity'
  const isImageScope = scope === 'image'
  const isPrevious = continuityRole === 'previous'
  const eyebrow = isContinuityScope ? 'STORY CONTINUITY' : isStoryScope ? 'STORY REFERENCES' : isImageScope ? 'IMAGE REFERENCES' : 'SCENE REFERENCES'
  const description = isContinuityScope
    ? isPrevious
      ? 'Attach the storyboard immediately before this one. It guides the current opening but is never recreated as output.'
      : 'Attach the storyboard immediately after this one. It guides the current ending but its future events are never shown early.'
    : isStoryScope
      ? 'These images guide the complete story context, every scene and every generated storyboard frame.'
      : isImageScope
        ? 'These images guide the prompt and the generated frame. Their order is preserved for the selected image model.'
      : 'These images guide only this scene. With one reference and no prompt, the original image is used exactly as the scene frame.'

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const nestedDialog = event.target instanceof Element ? event.target.closest('[role="dialog"]') : null
    if (nestedDialog && nestedDialog !== dialogRef.current) return
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab' || !dialogRef.current) return
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable.at(-1)!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div
      className="ef-story-reference-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className={`ef-story-reference-dialog${isContinuityScope ? ' is-continuity' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={handleKeyDown}
      >
        <header className="ef-story-reference-dialog-head">
          <span aria-hidden="true"><Icon glyph="img" size={16} /></span>
          <div>
            <small>{eyebrow}</small>
            <h2 id={titleId}>{sceneLabel}</h2>
            <p id={descriptionId}>{description}</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={`Close ${isContinuityScope ? 'story continuity' : isStoryScope ? 'story' : isImageScope ? 'image' : 'scene'} references`}>×</button>
        </header>

        <div className="ef-story-reference-dialog-body">
          {max > 0 ? (
            <ReferenceImageGrid
              images={images}
              max={max}
              onAddFiles={onAddFiles}
              onChooseLibrary={onChooseLibrary}
              libraryExcludedIds={[...new Set([
                ...images.flatMap((image) => 'creationId' in image && typeof image.creationId === 'string' ? [image.creationId] : []),
                ...(libraryExcludedIds ?? []),
              ])]}
              onRemove={onRemove}
              onGrabPlayhead={onGrabPlayhead}
              locked={locked}
              lockedHint={lockedHint}
              allowReplace={isContinuityScope}
              label={isContinuityScope
                ? isPrevious ? 'PREVIOUS STORYBOARD' : 'NEXT STORYBOARD'
                : isStoryScope ? 'REFERENCES FOR THE COMPLETE STORY' : isImageScope ? 'REFERENCES FOR THIS IMAGE' : 'REFERENCES FOR THIS SCENE'}
            />
          ) : (
            <div className="ef-story-reference-empty">
              <Icon glyph="board" size={16} />
              <span>{lockedHint || 'The selected image model does not accept reference images.'}</span>
            </div>
          )}
          <div className="ef-story-reference-rules">
            {isContinuityScope ? (
              <>
                <span><b>Continuity only</b> keeps identity, locations, palette and the visible boundary state consistent.</span>
                <span><b>{isPrevious ? 'Previous board' : 'Next board'}</b> is read in chronological order around the current references.</span>
                <span><b>Current output only</b> means the adjacent board is never copied, regenerated or added as a panel.</span>
              </>
            ) : isStoryScope ? (
              <>
                <span><b>Complete story + references</b> keeps the chosen identity, locations and visual language in context.</span>
                <span><b>Every scene</b> receives these images together with its own prompt and scene-specific references.</span>
                <span><b>Every generation</b> uses the shared references for continuity across the board and separate frames.</span>
              </>
            ) : isImageScope ? (
              <>
                <span><b>Prompt + references</b> are read together to direct the new image.</span>
                <span><b>Reference order</b> is preserved when the selected image model receives the files.</span>
                <span><b>Every attachment</b> is included in prompt enhancement and final generation.</span>
              </>
            ) : (
              <>
                <span><b>Prompt + references</b> generates a new frame using these images.</span>
                <span><b>No prompt + one reference</b> places that image in the storyboard without regenerating it.</span>
                <span><b>No prompt + multiple references</b> asks you to describe how they should be used.</span>
              </>
            )}
          </div>
        </div>

        <footer>
          <span>{images.length} / {max} attached</span>
          <button type="button" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
