import { useEffect, useState } from 'react'
import type { MediaKind } from '../core/contracts'

export interface WorkspacePreviewSource {
  name: string
  kind: MediaKind
  file?: File
  blobUrl?: string
}

interface WorkspaceSourcePreviewListProps {
  sources: WorkspacePreviewSource[]
  onRemove: (index: number) => void
  onClear: () => void
}

function useLocalPreviewUrl(source: WorkspacePreviewSource): string | undefined {
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string>()

  useEffect(() => {
    setLocalPreviewUrl(undefined)
    if (source.blobUrl || !source.file || (source.kind !== 'video' && source.kind !== 'audio')) return
    if (typeof URL.createObjectURL !== 'function') return

    const nextUrl = URL.createObjectURL(source.file)
    setLocalPreviewUrl(nextUrl)
    return () => URL.revokeObjectURL(nextUrl)
  }, [source.blobUrl, source.file, source.kind])

  return source.blobUrl ?? localPreviewUrl
}

function WorkspaceSourcePreview({ source, index, onRemove }: {
  source: WorkspacePreviewSource
  index: number
  onRemove: (index: number) => void
}) {
  const previewUrl = useLocalPreviewUrl(source)
  const label = `Preview ${source.name}`

  return (
    <article className="ef-workspace-source-card" aria-label={`${source.kind} source: ${source.name}`}>
      {source.kind === 'video' && previewUrl && (
        <div className="ef-workspace-source-preview ef-workspace-source-preview--video">
          <video src={previewUrl} controls playsInline preload="metadata" aria-label={label} />
        </div>
      )}
      {source.kind === 'audio' && previewUrl && (
        <div className="ef-workspace-source-preview ef-workspace-source-preview--audio">
          <audio src={previewUrl} controls preload="metadata" aria-label={label} />
        </div>
      )}
      <div className="ef-workspace-source-chip">
        <small>{source.kind}</small>
        <strong title={source.name}>{source.name}</strong>
        <button type="button" aria-label={`Remove source ${source.name}`} onClick={() => onRemove(index)}>×</button>
      </div>
    </article>
  )
}

export function WorkspaceSourcePreviewList({ sources, onRemove, onClear }: WorkspaceSourcePreviewListProps) {
  return (
    <div className="ef-workspace-source-list" aria-label="Selected source media">
      {sources.map((source, index) => (
        <WorkspaceSourcePreview
          source={source}
          index={index}
          onRemove={onRemove}
          key={`${source.kind}-${source.name}-${source.blobUrl ?? 'local'}-${index}`}
        />
      ))}
      {sources.length > 1 && (
        <button type="button" className="ef-workspace-source-clear" onClick={onClear}>Clear all</button>
      )}
    </div>
  )
}
