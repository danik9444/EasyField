import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Icon } from '../icons'
import type { ReferenceImage } from '../data/referenceImage'
import type { Creation } from '../data/creations'
import { copyLibraryCreationForWorkspace } from '../services/librarySelection'
import { LibraryPickerButton } from './LibraryPicker'

const MASK_ALPHA = 0.34

type Pt = { x: number; y: number }
type Stroke = { points: Pt[]; brush: number }
type ImageSize = { width: number; height: number }
type ImageRect = { left: number; top: number; width: number; height: number }

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  return `rgba(${parseInt(value.slice(0, 2), 16)}, ${parseInt(value.slice(2, 4), 16)}, ${parseInt(value.slice(4, 6), 16)}, ${alpha})`
}

function containedRect(boxWidth: number, boxHeight: number, image: ImageSize | null): ImageRect {
  if (!image?.width || !image.height) return { left: 0, top: 0, width: boxWidth, height: boxHeight }
  const imageRatio = image.width / image.height
  const boxRatio = boxWidth / Math.max(1, boxHeight)
  if (imageRatio > boxRatio) {
    const height = boxWidth / imageRatio
    return { left: 0, top: (boxHeight - height) / 2, width: boxWidth, height }
  }
  const width = boxHeight * imageRatio
  return { left: (boxWidth - width) / 2, top: 0, width, height: boxHeight }
}

interface MaskCanvasProps {
  source: ReferenceImage | null
  maskable: boolean
  brushSize: number
  color: string
  onPick: (file: File) => void
  onGrab?: () => void
  grabPending?: boolean
  disabled?: boolean
  onClearRef: (fn: () => void) => void
  onMaskExportRef?: (fn: () => Promise<Blob | null>) => void
  onMaskChange?: (hasMask: boolean) => void
  emptyTitle?: string
  emptyDescription?: string
  sourceLabel?: string
  uploadLabel?: string
  grabLabel?: string
  replaceGrabLabel?: string
  changeLabel?: string
  onChooseLibrary?: (creation: Creation) => void | Promise<void>
}

export function MaskCanvas({
  source,
  maskable,
  brushSize,
  color,
  onPick,
  onGrab,
  grabPending = false,
  disabled = false,
  onClearRef,
  onMaskExportRef,
  onMaskChange,
  emptyTitle = 'Choose an image to edit',
  emptyDescription = 'Upload a still, or capture the media under the Resolve playhead.',
  sourceLabel = 'Choose the primary image to edit',
  uploadLabel = 'Upload image',
  grabLabel = 'Grab from timeline',
  replaceGrabLabel = 'Grab',
  changeLabel = 'Change',
  onChooseLibrary,
}: MaskCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const strokesRef = useRef<Stroke[]>([])
  const currentRef = useRef<Stroke | null>(null)
  const drawingRef = useRef(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [imageSize, setImageSize] = useState<ImageSize | null>(null)
  const [canvasVersion, setCanvasVersion] = useState(0)

  const sourceUrl = source?.kind === 'upload' ? source.url : null
  const isPlayhead = source?.kind === 'playhead'
  const ratio = imageSize ? imageSize.width / imageSize.height : null

  useEffect(() => {
    if (!sourceUrl) {
      setImageSize(null)
      return
    }
    let cancelled = false
    const image = new Image()
    image.onload = () => {
      if (!cancelled && image.naturalWidth && image.naturalHeight) {
        setImageSize({ width: image.naturalWidth, height: image.naturalHeight })
      }
    }
    image.src = sourceUrl
    return () => {
      cancelled = true
    }
  }, [sourceUrl])

  const drawStroke = (
    context: CanvasRenderingContext2D,
    stroke: Stroke,
    rect: ImageRect,
    natural = false,
  ) => {
    if (!stroke.points.length) return
    const points = stroke.points.map((point) => ({
      x: rect.left + point.x * rect.width,
      y: rect.top + point.y * rect.height,
    }))
    const scale = Math.min(rect.width, rect.height)
    context.lineWidth = Math.max(1, stroke.brush * scale)
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.strokeStyle = natural ? '#ffffff' : hexToRgba(color, MASK_ALPHA)
    context.fillStyle = natural ? '#ffffff' : hexToRgba(color, MASK_ALPHA)
    if (points.length === 1) {
      context.beginPath()
      context.arc(points[0].x, points[0].y, context.lineWidth / 2, 0, Math.PI * 2)
      context.fill()
      return
    }
    context.beginPath()
    context.moveTo(points[0].x, points[0].y)
    for (let index = 1; index < points.length - 1; index += 1) {
      const midpointX = (points[index].x + points[index + 1].x) / 2
      const midpointY = (points[index].y + points[index + 1].y) / 2
      context.quadraticCurveTo(points[index].x, points[index].y, midpointX, midpointY)
    }
    const last = points[points.length - 1]
    context.lineTo(last.x, last.y)
    context.stroke()
  }

  const redraw = () => {
    const canvas = canvasRef.current
    const wrapper = wrapRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !wrapper || !context) return
    const box = wrapper.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const width = Math.max(1, Math.round(box.width * dpr))
    const height = Math.max(1, Math.round(box.height * dpr))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    canvas.style.width = `${box.width}px`
    canvas.style.height = `${box.height}px`
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, box.width, box.height)
    const rect = containedRect(box.width, box.height, imageSize)
    strokesRef.current.forEach((stroke) => drawStroke(context, stroke, rect))
    if (currentRef.current) drawStroke(context, currentRef.current, rect)
  }

  useEffect(() => {
    strokesRef.current = []
    currentRef.current = null
    onMaskChange?.(false)
    const frame = requestAnimationFrame(redraw)
    return () => cancelAnimationFrame(frame)
    // A new source or mode always starts with a clean mask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceUrl, isPlayhead, maskable, imageSize?.width, imageSize?.height])

  useEffect(() => {
    const wrapper = wrapRef.current
    if (!wrapper) return
    const observer = new ResizeObserver(() => redraw())
    observer.observe(wrapper)
    const frame = requestAnimationFrame(redraw)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageSize, canvasVersion, color])

  const clear = () => {
    strokesRef.current = []
    currentRef.current = null
    drawingRef.current = false
    onMaskChange?.(false)
    setCanvasVersion((version) => version + 1)
  }

  const exportMask = async (): Promise<Blob | null> => {
    if (!imageSize || strokesRef.current.length === 0) return null
    const canvas = document.createElement('canvas')
    canvas.width = imageSize.width
    canvas.height = imageSize.height
    const context = canvas.getContext('2d')
    if (!context) return null
    context.fillStyle = '#000000'
    context.fillRect(0, 0, canvas.width, canvas.height)
    const rect = { left: 0, top: 0, width: imageSize.width, height: imageSize.height }
    strokesRef.current.forEach((stroke) => drawStroke(context, stroke, rect, true))
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  }

  useEffect(() => {
    onClearRef(clear)
  }, [onClearRef])

  useEffect(() => {
    onMaskExportRef?.(exportMask)
  }, [onMaskExportRef, imageSize])

  const pointFromEvent = (event: ReactPointerEvent): Pt | null => {
    const wrapper = wrapRef.current
    if (!wrapper) return null
    const box = wrapper.getBoundingClientRect()
    const rect = containedRect(box.width, box.height, imageSize)
    const x = event.clientX - box.left
    const y = event.clientY - box.top
    if (x < rect.left || x > rect.left + rect.width || y < rect.top || y > rect.top + rect.height) return null
    return {
      x: Math.min(1, Math.max(0, (x - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (y - rect.top) / rect.height)),
    }
  }

  const onDown = (event: ReactPointerEvent) => {
    if (disabled || !maskable || !source || !imageSize) return
    const point = pointFromEvent(event)
    if (!point) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const wrapper = wrapRef.current?.getBoundingClientRect()
    const rect = containedRect(wrapper?.width ?? 1, wrapper?.height ?? 1, imageSize)
    currentRef.current = { points: [point], brush: brushSize / Math.max(1, Math.min(rect.width, rect.height)) }
    drawingRef.current = true
    redraw()
  }

  const onMove = (event: ReactPointerEvent) => {
    if (!drawingRef.current || !currentRef.current) return
    const point = pointFromEvent(event)
    if (!point) return
    currentRef.current.points.push(point)
    redraw()
  }

  const onUp = () => {
    if (!drawingRef.current || !currentRef.current) return
    drawingRef.current = false
    strokesRef.current.push(currentRef.current)
    currentRef.current = null
    onMaskChange?.(true)
    redraw()
  }

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) onPick(file)
  }

  const chooseLibrary = async ([creation]: Creation[]) => {
    if (!creation) return
    if (onChooseLibrary) await onChooseLibrary(creation)
    else onPick(await copyLibraryCreationForWorkspace(creation))
  }

  return (
    <div className="ef-edit-canvas" ref={wrapRef} style={ratio ? { aspectRatio: String(ratio) } : undefined} aria-busy={grabPending}>
      <div
        className={'ef-edit-canvas-bg' + (isPlayhead ? ' playhead' : '')}
        style={sourceUrl ? { backgroundImage: `url(${sourceUrl})` } : undefined}
      >
        {!source && (
          <div className="ef-edit-canvas-empty" role="group" aria-label={sourceLabel}>
            <span className="ef-edit-canvas-empty-icon"><Icon glyph="img" size={20} /></span>
            <strong>{emptyTitle}</strong>
            <span>{emptyDescription}</span>
            <div className="ef-edit-canvas-empty-actions">
              <button type="button" className="ef-canvas-btn" disabled={disabled || grabPending} onClick={() => fileRef.current?.click()}>
                <Icon glyph="up" size={12} /> {uploadLabel}
              </button>
              <LibraryPickerButton
                kinds={['image']}
                max={1}
                disabled={disabled || grabPending}
                onSelect={chooseLibrary}
                className="ef-canvas-btn ef-library-source-btn"
                ariaLabel="Choose primary image from Library"
                pickerTitle="Choose an image to edit"
                confirmLabel="Use image"
              />
              {onGrab && (
                <button
                  type="button"
                  className="ef-canvas-btn ef-canvas-btn--grab"
                  disabled={disabled || grabPending}
                  onClick={onGrab}
                  aria-label="Grab the image or current video frame under the Resolve playhead"
                >
                  <Icon glyph="playhead" size={12} /> {grabPending ? 'Grabbing…' : grabLabel}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {maskable && source && (
        <canvas
          ref={canvasRef}
          className="ef-mask-canvas"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
      )}

      {source && (
        <div className="ef-edit-canvas-toolbar">
          {maskable && <button type="button" className="ef-canvas-btn" disabled={disabled || grabPending} aria-label="Clear mask" onClick={clear}>Clear mask</button>}
          <LibraryPickerButton
            kinds={['image']}
            max={1}
            disabled={disabled || grabPending}
            onSelect={chooseLibrary}
            className="ef-canvas-btn ef-library-source-btn"
            ariaLabel="Replace primary image from Library"
            pickerTitle="Replace with a Library image"
            confirmLabel="Use image"
          />
          {onGrab && (
            <button
              type="button"
              className="ef-canvas-btn ef-canvas-btn--grab"
              disabled={disabled || grabPending}
              aria-label="Replace with the image or current video frame under the Resolve playhead"
              onClick={onGrab}
            >
              <Icon glyph="playhead" size={11} /> {grabPending ? 'Grabbing…' : replaceGrabLabel}
            </button>
          )}
          <button type="button" className="ef-canvas-btn" disabled={disabled || grabPending} aria-label={changeLabel} onClick={() => fileRef.current?.click()}>{changeLabel}</button>
        </div>
      )}

      {maskable && source && <span className="ef-mask-hint">Paint only the area you want to replace</span>}
      <input ref={fileRef} type="file" accept="image/*" disabled={disabled || grabPending} onChange={handleFile} style={{ display: 'none' }} />
    </div>
  )
}
