import type { BeatDetectionResult } from '../services/beatDetection'
import type { BeatMarker } from '../data/beatWorkflow'
import { Icon } from '../icons'

interface BeatAnalysisResultProps {
  result: BeatDetectionResult
  sourceName: string
  markers?: BeatMarker[]
  mode?: 'markers' | 'align'
  savedToLibrary?: boolean
  rangeLabel?: string
  importing?: 'timeline' | 'media-pool' | null
  onDownloadAudio?: () => void
  onDownloadSidecar?: () => void
  onDownloadBoth?: () => void
  onImportMediaPool?: () => void
  onImportTimeline?: () => void
}

function formatTime(seconds: number): string {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000))
  const minutes = Math.floor(totalMilliseconds / 60000)
  const remainingSeconds = Math.floor((totalMilliseconds % 60000) / 1000)
  const milliseconds = totalMilliseconds % 1000
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`
}

export function BeatAnalysisResult({
  result,
  sourceName,
  markers,
  mode = 'markers',
  savedToLibrary = false,
  rangeLabel,
  importing = null,
  onDownloadAudio,
  onDownloadSidecar,
  onDownloadBoth,
  onImportMediaPool,
  onImportTimeline,
}: BeatAnalysisResultProps) {
  const selectedMarkers = markers ?? result.beats.map((beat, index) => ({ ...beat, sourceBeatIndex: index, name: `Beat ${index + 1}` }))
  const visibleBeats = selectedMarkers.slice(0, 300)
  const confidencePercent = Math.round(result.confidence * 100)

  return (
    <section className="ef-beat-result ef-beat-section" aria-labelledby="ef-beat-result-title">
      <div className="ef-beat-result-head">
        <div><span>03 · BEAT MAP</span><h2 id="ef-beat-result-title">Rhythm mapped and ready.</h2><p>{savedToLibrary ? 'The analysis is linked to the same audio in Library and updates with these controls.' : 'Review the selected markers before applying them.'}</p></div>
        <span className={savedToLibrary ? 'is-saved' : ''}><i />{savedToLibrary ? 'SAVED IN LIBRARY' : 'NOT SAVED'}</span>
      </div>

      <div className="ef-beat-metrics" aria-label="Beat analysis summary">
        <span><small>TEMPO</small><strong>{result.bpm || '—'}</strong><em>BPM</em></span>
        <span><small>MARKERS</small><strong>{selectedMarkers.length}</strong><em>of {result.beats.length} detected</em></span>
        <span><small>CONFIDENCE</small><strong>{confidencePercent}%</strong><em>analysis quality</em></span>
      </div>

      <div className="ef-beat-timeline" aria-label={`Preview of ${visibleBeats.length} detected beat positions`}>
        <div className="ef-beat-ruler" aria-hidden="true">
          {visibleBeats.map((beat, index) => (
            <i
              key={`${beat.time}-${index}`}
              style={{
                left: `${result.durationSeconds > 0 ? Math.min(100, beat.time / result.durationSeconds * 100) : 0}%`,
                opacity: 0.35 + beat.confidence * 0.65,
              }}
            />
          ))}
        </div>
        <span><b>00:00</b><b>{formatTime(result.durationSeconds)}</b></span>
      </div>

      <dl className="ef-beat-details">
        <div><dt>Source</dt><dd title={sourceName}>{sourceName}</dd></div>
        <div><dt>Engine</dt><dd>librosa {result.engineVersion}</dd></div>
        <div><dt>Output</dt><dd>{mode === 'align' ? 'Alignment remains disabled until safe cut snapshots are available' : 'Clip markers attached to an imported audio copy'}</dd></div>
        <div><dt>Range</dt><dd>{rangeLabel || `00:00 – ${formatTime(result.durationSeconds)}`}</dd></div>
        <div><dt>First markers</dt><dd>{selectedMarkers.length ? selectedMarkers.slice(0, 6).map((beat) => formatTime(beat.time)).join(' · ') : 'No beats match the current filter'}</dd></div>
        <div><dt>Audio</dt><dd>{(result.sampleRate / 1000).toFixed(result.sampleRate % 1000 ? 1 : 0)} kHz · {formatTime(result.durationSeconds)}</dd></div>
      </dl>

      {selectedMarkers.length === 0 && <p className="ef-inline-warning" role="status">No markers match the current filter. Lower the confidence threshold, reduce spacing, or widen the range.</p>}

      {(onDownloadAudio || onDownloadSidecar || onDownloadBoth) && (
        <div className="ef-beat-result-group">
          <div><span>DOWNLOAD</span><small>Keep the sound and its linked analysis together.</small></div>
          <div className="ef-beat-result-actions">
            {onDownloadAudio && <button type="button" onClick={onDownloadAudio}><Icon glyph="music" size={12} /> Audio</button>}
            {onDownloadSidecar && <button type="button" onClick={onDownloadSidecar}><Icon glyph="board" size={12} /> Beat JSON</button>}
            {onDownloadBoth && <button type="button" className="is-primary" onClick={onDownloadBoth}><Icon glyph="up" size={12} /> Download both</button>}
          </div>
        </div>
      )}

      {(onImportMediaPool || onImportTimeline) && (
        <div className="ef-beat-result-group is-resolve">
          <div><span>DAVINCI RESOLVE</span><small>A new audio copy is imported; existing clips and markers stay untouched.</small></div>
          <div className="ef-beat-result-actions">
            {onImportMediaPool && <button type="button" disabled={!selectedMarkers.length || !!importing} onClick={onImportMediaPool}><Icon glyph="board" size={12} />{importing === 'media-pool' ? 'Importing…' : 'Media Pool + markers'}</button>}
            {onImportTimeline && <button type="button" className="is-primary" disabled={!selectedMarkers.length || !!importing} onClick={onImportTimeline}><Icon glyph="playhead" size={12} />{importing === 'timeline' ? 'Placing…' : 'Timeline + markers'}</button>}
          </div>
        </div>
      )}
    </section>
  )
}
