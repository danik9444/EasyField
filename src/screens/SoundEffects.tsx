import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons'
import { Dropdown } from '../components/Dropdown'
import { ChipField } from '../components/ChipField'
import { PriceEstimate } from '../components/PriceEstimate'
import { PromptCard } from '../components/PromptCard'
import { VideoSourcePanel } from '../components/VideoSourcePanel'
import { FoleyEventList } from '../components/FoleyEventList'
import { GenerationCancelControl, useGenerationJobControl } from '../components/GenerationCancelControl'
import { addCreations } from '../data/creations'
import { SOUND_EFFECT_KEYS, type SoundEffectCtx } from '../data/providerModels'
import { SOUND_EFFECT_MODEL_META } from '../data/modelPresentation'
import { AGENT_MODELS, DEFAULT_AGENT_MODEL } from '../data/models'
import { loadValue, saveValue } from '../data/prefs'
import {
  FOLEY_GUIDANCE_MODES,
  makeFoleyEventStates,
  normalizeSoundEffectsPreferences,
  resolveFoleyDirection,
  SOUND_EFFECT_MODES,
  type FoleyEventState,
  type FoleyGuidanceMode,
  type SoundEffectsMode,
} from '../data/soundEffects'
import { formatCharged, resolveCharged, soundEffectsRunEstimate } from '../data/pricing'
import type { MediaFile } from '../data/referenceImage'
import { loadSettings } from '../settings'
import { planFoleyEvents, type EnhanceReference } from '../services/chat'
import { isConnected, isGenerationExit, runSoundEffect, runSoundEffectBatch } from '../services/run'
import { resolve, type Grab } from '../services/resolve'
import { getSpendApproval } from '../services/spendGuard'
import {
  sendTimedAudioToTimeline,
  sendToTimeline,
  type TimelinePlacementAnchor,
} from '../services/timeline'
import { readVideoDuration } from '../services/videoContext'

const MODELS = [
  { id: 'V5_5' as const, label: 'v5.5' },
  { id: 'V5' as const, label: 'v5' },
]
const PREFS_KEY = 'sound-effects'
const PROMPT_MAX = 500
const FOLEY_DIRECTION_MAX = 1200

type Phase = 'form' | 'generating' | 'done'

interface SoundEffectsProps {
  onBack: () => void
  toast: (message: string) => void
  onSpend: (credits: number) => void
}

interface SoundResult {
  id: string
  url: string
  prompt: string
}

function loadSoundPreferences() {
  try {
    const raw = loadValue(PREFS_KEY)
    return normalizeSoundEffectsPreferences(raw ? JSON.parse(raw) : null)
  } catch {
    return normalizeSoundEffectsPreferences(null)
  }
}

const modelLabel = (model: SoundEffectCtx['model']) => MODELS.find((entry) => entry.id === model)?.label ?? model
const enhancerModelFor = (key: string) => {
  const selected = loadValue(key)
  return selected && AGENT_MODELS.includes(selected) ? selected : DEFAULT_AGENT_MODEL
}

function revokeMedia(source: MediaFile | null): void {
  if (source?.kind === 'upload') URL.revokeObjectURL(source.url)
}

function anchorFromCapture(grab: Grab): TimelinePlacementAnchor | null {
  if (
    !grab.projectId
    || !grab.timelineId
    || !grab.itemId
    || !Number.isSafeInteger(grab.itemStartFrame)
    || !Number.isSafeInteger(grab.itemEndFrame)
    || !Number.isFinite(grab.timelineFps)
    || grab.timelineFps! <= 0
  ) return null
  return {
    projectId: grab.projectId,
    timelineId: grab.timelineId,
    itemId: grab.itemId,
    itemStartFrame: grab.itemStartFrame!,
    itemEndFrame: grab.itemEndFrame!,
    fps: grab.timelineFps!,
  }
}

export function SoundEffects({ onBack, toast, onSpend }: SoundEffectsProps) {
  const saved = useRef(loadSoundPreferences()).current
  const [mode, setMode] = useState<SoundEffectsMode>(saved.mode)
  const [model, setModel] = useState<SoundEffectCtx['model']>(saved.model)
  const [singlePrompt, setSinglePrompt] = useState(saved.singlePrompt)
  const [foleyGuidance, setFoleyGuidance] = useState<FoleyGuidanceMode>(saved.foleyGuidance)
  const [foleyDirection, setFoleyDirection] = useState(saved.foleyDirection)
  const [loop, setLoop] = useState(saved.loop)
  const [bpm, setBpm] = useState(String(saved.bpm))
  const [key, setKey] = useState<SoundEffectCtx['key']>(saved.key)
  const [advancedOpen, setAdvancedOpen] = useState(saved.advancedOpen)

  const [source, setSource] = useState<MediaFile | null>(null)
  const sourceRef = useRef<MediaFile | null>(null)
  const [sourceAnchor, setSourceAnchor] = useState<TimelinePlacementAnchor | null>(null)
  const sourceCaptureIdRef = useRef(0)
  const sourceGrabPendingRef = useRef(false)
  const [sourceGrabPending, setSourceGrabPending] = useState(false)
  const unmountedRef = useRef(false)

  const [phase, setPhase] = useState<Phase>('form')
  const [results, setResults] = useState<SoundResult[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [charged, setCharged] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [foleySummary, setFoleySummary] = useState('')
  const [foleyEvents, setFoleyEvents] = useState<FoleyEventState[]>([])
  const [foleyAnalyzing, setFoleyAnalyzing] = useState(false)
  const [foleyGenerating, setFoleyGenerating] = useState(false)
  const analysisIdRef = useRef(0)
  const analysisAbortRef = useRef<AbortController | null>(null)
  const activeFoleyIdsRef = useRef<string[]>([])

  const activeRunRef = useRef(false)
  const activeRunIdRef = useRef(0)
  const generation = useGenerationJobControl()
  const idRef = useRef(0)
  const nextId = (prefix: string) => `${prefix}-${++idRef.current}`

  const invalidateVideoWork = useCallback(() => {
    analysisIdRef.current += 1
    analysisAbortRef.current?.abort()
    analysisAbortRef.current = null
    setFoleyAnalyzing(false)
    setFoleySummary('')
    setFoleyEvents([])
    setError(null)
    setResults([])
    setSelectedIds([])
    setCharged(null)
    setPhase('form')
  }, [])

  const replaceSource = useCallback((next: MediaFile, anchor: TimelinePlacementAnchor | null) => {
    const previous = sourceRef.current
    if (previous?.kind === 'upload' && (next.kind !== 'upload' || next.url !== previous.url)) URL.revokeObjectURL(previous.url)
    sourceRef.current = next
    setSource(next)
    setSourceAnchor(anchor)
    invalidateVideoWork()
  }, [invalidateVideoWork])

  useEffect(() => {
    sourceRef.current = source
  }, [source])

  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
      sourceCaptureIdRef.current += 1
      analysisIdRef.current += 1
      analysisAbortRef.current?.abort()
      revokeMedia(sourceRef.current)
    }
  }, [])

  useEffect(() => {
    saveValue(PREFS_KEY, JSON.stringify({
      mode,
      model,
      singlePrompt,
      foleyGuidance,
      foleyDirection,
      loop,
      bpm: Number(bpm),
      key,
      advancedOpen,
    }))
  }, [advancedOpen, bpm, foleyDirection, foleyGuidance, key, loop, mode, model, singlePrompt])

  const pickVideoSource = useCallback(async (file: File) => {
    if (activeRunRef.current || foleyAnalyzing) return
    const captureId = ++sourceCaptureIdRef.current
    sourceGrabPendingRef.current = false
    setSourceGrabPending(false)
    const url = URL.createObjectURL(file)
    try {
      const durationSeconds = await readVideoDuration(url)
      if (captureId !== sourceCaptureIdRef.current || unmountedRef.current) {
        URL.revokeObjectURL(url)
        return
      }
      replaceSource({
        id: nextId('sfx-video'),
        kind: 'upload',
        name: file.name,
        url,
        mimeType: file.type || 'video/mp4',
        byteSize: file.size,
        durationSeconds,
      }, null)
      toast(`Video ready · ${durationSeconds.toFixed(durationSeconds < 10 ? 2 : 1)}s`)
    } catch (pickError) {
      URL.revokeObjectURL(url)
      if (captureId === sourceCaptureIdRef.current) toast(pickError instanceof Error ? pickError.message : 'This video could not be opened.')
    }
  }, [foleyAnalyzing, replaceSource, toast])

  const grabVideoSource = useCallback(async () => {
    if (activeRunRef.current || foleyAnalyzing || sourceGrabPendingRef.current) return
    const captureId = ++sourceCaptureIdRef.current
    sourceGrabPendingRef.current = true
    setSourceGrabPending(true)
    const grabbed = await resolve.grabEditVideoSource()
    if (captureId !== sourceCaptureIdRef.current || unmountedRef.current) {
      if (grabbed.ok && grabbed.blobUrl) URL.revokeObjectURL(grabbed.blobUrl)
      return
    }
    sourceGrabPendingRef.current = false
    setSourceGrabPending(false)
    if (!grabbed.ok || !grabbed.blobUrl) {
      toast(`Video Grab failed · ${grabbed.error || 'place the playhead over a normal video clip'}`)
      return
    }
    replaceSource({
      id: nextId('sfx-video'),
      kind: 'upload',
      name: grabbed.name,
      url: grabbed.blobUrl,
      mimeType: 'video/mp4',
      durationSeconds: grabbed.durationSeconds,
    }, anchorFromCapture(grabbed))
    toast(`Trimmed timeline clip captured${grabbed.durationSeconds ? ` · ${grabbed.durationSeconds.toFixed(grabbed.durationSeconds < 10 ? 2 : 1)}s` : ''}`)
  }, [foleyAnalyzing, replaceSource, toast])

  const videoReferences = useMemo<EnhanceReference[]>(() => source?.kind === 'upload' ? [{
    role: 'source video for Foley planning',
    label: source.name,
    videoUrl: source.url,
    durationSeconds: source.durationSeconds,
    note: sourceAnchor ? 'Exact trimmed Resolve source clip; frames are ordered from its Source In to Source Out.' : 'Uploaded source clip; frames are ordered from start to end.',
  }] : [], [source, sourceAnchor])

  const bpmNumber = Number(bpm)
  const bpmValid = Number.isInteger(bpmNumber) && bpmNumber >= 1 && bpmNumber <= 300
  const connected = isConnected()
  const activeMode = SOUND_EFFECT_MODES.find((entry) => entry.id === mode) ?? SOUND_EFFECT_MODES[0]
  const activeGuidance = FOLEY_GUIDANCE_MODES.find((entry) => entry.id === foleyGuidance) ?? FOLEY_GUIDANCE_MODES[0]
  const activePrompt = singlePrompt
  const sourceReady = source?.kind === 'upload' && !!source.url && !!source.durationSeconds
  const pendingFoley = foleyEvents.filter((event) => event.approved && !event.urls.length && event.prompt.trim())
  const approvedFoley = foleyEvents.filter((event) => event.approved && event.prompt.trim())
  const estimate = soundEffectsRunEstimate(mode === 'foley' ? Math.max(1, pendingFoley.length) : 1)
  const spendApproval = getSpendApproval(estimate, loadSettings().spendLimit)
  const spendBlocked = connected && !spendApproval.approved
  const busy = phase === 'generating' || foleyAnalyzing || foleyGenerating

  const changeFoleyGuidance = (next: FoleyGuidanceMode) => {
    if (busy || next === foleyGuidance) return
    invalidateVideoWork()
    setFoleyGuidance(next)
  }

  const changeFoleyDirection = (next: string) => {
    if (foleyAnalyzing || foleySummary || foleyEvents.length) invalidateVideoWork()
    setFoleyDirection(next)
  }

  const generateSound = async () => {
    if (activeRunRef.current || mode !== 'single' || !connected || !bpmValid || !activePrompt.trim() || activePrompt.trim().length > PROMPT_MAX) return
    const runId = ++activeRunIdRef.current
    activeRunRef.current = true
    setError(null)
    setSelectedIds([])
    setPhase('generating')
    const controller = generation.begin()
    try {
      const finalPrompt = activePrompt.trim()
      const result = await runSoundEffect({
        model,
        prompt: finalPrompt,
        loop,
        bpm: bpmNumber,
        key,
        grabLyrics: false,
      }, { signal: controller.signal, onJobCreated: generation.attachJob })
      if (controller.signal.aborted || runId !== activeRunIdRef.current) return
      if (!result.urls.length) throw new Error('No sound was returned — please try again.')
      const finalCharge = result.credits ?? resolveCharged(estimate)
      setCharged(finalCharge)
      onSpend(finalCharge ?? 0)
      const nextResults = result.urls.map((url) => ({ id: nextId('sfx-result'), url, prompt: finalPrompt }))
      setResults(nextResults)
      addCreations(result.urls.map((url) => ({
        kind: 'audio',
        url,
        model: `Suno Sounds ${modelLabel(model)}`,
        prompt: finalPrompt.slice(0, 120),
        meta: `${loop ? 'loop' : 'one-shot'} · ${bpmNumber} BPM${key === 'Any' ? '' : ` · ${key}`}`,
      })))
      setPhase('done')
    } catch (generationError) {
      if (controller.signal.aborted || isGenerationExit(generationError) || runId !== activeRunIdRef.current) {
        setPhase('form')
        return
      }
      setError(generationError instanceof Error ? generationError.message : String(generationError))
      setPhase('form')
    } finally {
      generation.finish(controller)
      if (runId === activeRunIdRef.current) activeRunRef.current = false
    }
  }

  const analyzeFoley = async () => {
    const direction = resolveFoleyDirection(foleyGuidance, foleyDirection)
    if (!sourceReady || !connected || foleyAnalyzing || foleyGenerating || (foleyGuidance === 'guided' && !direction)) return
    const analysisId = ++analysisIdRef.current
    analysisAbortRef.current?.abort()
    const controller = new AbortController()
    analysisAbortRef.current = controller
    setFoleyAnalyzing(true)
    setError(null)
    try {
      const result = await planFoleyEvents({
        direction,
        sourceName: source!.name,
        sourceVideoUrl: source!.kind === 'upload' ? source!.url : '',
        durationSeconds: source!.durationSeconds!,
        chatModel: enhancerModelFor('enhancer-sfx-foley'),
        signal: controller.signal,
      })
      if (controller.signal.aborted || analysisId !== analysisIdRef.current || unmountedRef.current) return
      setFoleySummary(result.summary)
      setFoleyEvents(makeFoleyEventStates(result.events, nextId('foley-plan')))
      if (result.chatCredits != null) onSpend(result.chatCredits)
    } catch (analysisError) {
      if (controller.signal.aborted || analysisId !== analysisIdRef.current) return
      setError(analysisError instanceof Error ? analysisError.message : String(analysisError))
    } finally {
      if (analysisId === analysisIdRef.current) {
        analysisAbortRef.current = null
        setFoleyAnalyzing(false)
      }
    }
  }

  const generateFoleyEvents = async (ids: string[]) => {
    const selected = foleyEvents.filter((event) => ids.includes(event.id) && event.approved && event.prompt.trim())
    if (!selected.length || activeRunRef.current || !connected) return
    const runId = ++activeRunIdRef.current
    activeRunRef.current = true
    activeFoleyIdsRef.current = selected.map((event) => event.id)
    setFoleyGenerating(true)
    setError(null)
    setFoleyEvents((current) => current.map((event) => ids.includes(event.id) ? { ...event, status: 'generating', error: undefined } : event))
    const controller = generation.begin()
    try {
      const result = await runSoundEffectBatch(selected.map((event) => ({
        id: event.id,
        title: event.title,
        sound: {
          model,
          prompt: event.prompt,
          loop: false,
          bpm: 120,
          key: 'Any',
          grabLyrics: false,
        },
      })), { signal: controller.signal, onJobCreated: generation.attachJob })
      if (controller.signal.aborted || runId !== activeRunIdRef.current) return
      setFoleyEvents((current) => current.map((event) => {
        const item = result.items.find((entry) => entry.id === event.id)
        if (!item) return event
        if (item.urls.length) return { ...event, status: 'done', urls: [...event.urls, ...item.urls], charged: item.credits, error: undefined }
        return { ...event, status: item.pending ? 'pending' : 'error', error: item.error || 'No sound was returned.' }
      }))
      const promptById = new Map(selected.map((event) => [event.id, event]))
      addCreations(result.items.flatMap((item) => item.urls.map((url) => {
        const event = promptById.get(item.id)!
        return {
          kind: 'audio' as const,
          url,
          model: `Suno Sounds ${modelLabel(model)}`,
          prompt: event.prompt.slice(0, 120),
          meta: `Auto Foley · ${event.startSeconds.toFixed(2)}s · ${event.confidence} confidence`,
        }
      })))
      onSpend(result.credits ?? 0)
    } catch (batchError) {
      if (controller.signal.aborted || isGenerationExit(batchError) || runId !== activeRunIdRef.current) {
        setFoleyEvents((current) => current.map((event) => ids.includes(event.id)
          ? { ...event, status: isGenerationExit(batchError) ? 'pending' : 'ready' }
          : event))
        return
      }
      const message = batchError instanceof Error ? batchError.message : String(batchError)
      setError(message)
      setFoleyEvents((current) => current.map((event) => ids.includes(event.id) ? { ...event, status: 'error', error: message } : event))
    } finally {
      generation.finish(controller)
      if (runId === activeRunIdRef.current) {
        activeRunRef.current = false
        activeFoleyIdsRef.current = []
        setFoleyGenerating(false)
      }
    }
  }

  const exitGeneration = () => {
    const outcome = generation.exit()
    if (!outcome) return
    const affected = activeFoleyIdsRef.current
    activeRunIdRef.current += 1
    activeRunRef.current = false
    setFoleyGenerating(false)
    if (affected.length) {
      setFoleyEvents((current) => current.map((event) => affected.includes(event.id)
        ? { ...event, status: outcome === 'backgrounded' ? 'pending' : 'ready' }
        : event))
      activeFoleyIdsRef.current = []
    } else {
      setPhase('form')
    }
    toast(outcome === 'backgrounded'
      ? 'Sound generation continues in Activity · finished audio will be saved to Library'
      : 'Sound generation cancelled')
  }

  const updateFoleyPrompt = (id: string, prompt: string) => {
    setFoleyEvents((current) => current.map((event) => event.id === id
      ? { ...event, prompt, status: event.urls.length ? 'done' : 'ready', error: undefined }
      : event))
  }

  const placeFoleyEvent = async (id: string) => {
    const event = foleyEvents.find((candidate) => candidate.id === id)
    if (!event?.urls.length) return
    const items = event.urls.map((url, index) => ({ url, name: `${event.title}${event.urls.length > 1 ? ` ${index + 1}` : ''}` }))
    if (sourceAnchor) {
      await sendTimedAudioToTimeline(items.map((item) => ({ ...item, offsetSeconds: event.startSeconds })), sourceAnchor, toast)
    } else {
      await sendToTimeline(items, 'audio', toast)
    }
  }

  const changeMode = (next: SoundEffectsMode) => {
    if (busy || next === mode) return
    invalidateVideoWork()
    setMode(next)
  }

  const renderAdvanced = () => (
    <>
      <button
        id="sfx-advanced-toggle"
        type="button"
        className="ef-advanced-toggle"
        aria-expanded={advancedOpen}
        aria-controls="sfx-advanced-options"
        onClick={() => setAdvancedOpen((open) => !open)}
      >
        <span className="ef-advanced-toggle-label">Advanced sound controls</span>
        <span className="ef-advanced-summary">Tempo and musical key</span>
        <span className="ef-advanced-chevron" aria-hidden="true">⌄</span>
      </button>
      <div id="sfx-advanced-options" className="ef-advanced-region ef-sfx-advanced" role="region" aria-labelledby="sfx-advanced-toggle" hidden={!advancedOpen}>
        <div className="ef-field">
          <div className="ef-ref-header">
            <label className="ef-field-label" htmlFor="ef-sfx-bpm">BPM</label>
            <span className="ef-spacer" />
            <span className="ef-ref-count">1–300</span>
          </div>
          <input
            id="ef-sfx-bpm"
            className="ef-text-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={300}
            step={1}
            value={bpm}
            aria-invalid={!bpmValid}
            onChange={(event) => setBpm(event.target.value)}
          />
        </div>
        <div className="ef-field">
          <span className="ef-field-label">MUSICAL KEY</span>
          <Dropdown options={[...SOUND_EFFECT_KEYS]} selected={key} onSelect={(next) => setKey(next as SoundEffectCtx['key'])} label="Musical key" align="left" variant="field" />
        </div>
      </div>
    </>
  )

  const standardValidation = !activePrompt.trim()
    ? 'Describe the sound effect'
    : activePrompt.trim().length > PROMPT_MAX
      ? `Keep the sound prompt under ${PROMPT_MAX} characters`
      : !bpmValid
        ? 'Enter a whole-number BPM from 1 to 300'
        : null
  const foleyGuidanceValidation = mode === 'foley' && foleyGuidance === 'guided'
    ? !foleyDirection.trim()
      ? 'Write Foley direction or choose Full auto'
      : foleyDirection.trim().length > FOLEY_DIRECTION_MAX
        ? `Keep the Foley direction under ${FOLEY_DIRECTION_MAX} characters`
        : null
    : null
  const canGenerateStandard = mode === 'single' && !standardValidation && connected && spendApproval.approved && !busy
  const canAnalyze = mode === 'foley' && sourceReady && connected && !busy && !foleyGuidanceValidation
  const canGenerateFoley = mode === 'foley' && pendingFoley.length > 0 && connected && spendApproval.approved && !busy

  return (
    <div className={`ef-screen ef-legacy-workspace ef-sound-effects-screen ef-sfx-mode-${mode}`}>
      <div className="ef-sub-header">
        <button type="button" className="ef-back" onClick={onBack} aria-label="Back to tools">‹</button>
        <span className="ef-sub-title">Sound Effects</span>
        <span className="ef-spacer" />
        <Dropdown
          options={MODELS.map((entry) => entry.label)}
          selected={modelLabel(model)}
          onSelect={(label) => setModel(MODELS.find((entry) => entry.label === label)?.id ?? model)}
          label="Suno Sounds model"
          optionMeta={SOUND_EFFECT_MODEL_META}
          searchable={false}
        />
      </div>

      <div className="ef-scroll ef-create-scroll">
        <div className="ef-edit-mode-bar ef-sfx-mode-bar" role="group" aria-label="Sound Effects mode">
          <span><small>WORKFLOW</small><strong>{activeMode.summary}</strong></span>
          <div className="ef-setting-segmented">
            {SOUND_EFFECT_MODES.map((option) => (
              <button
                type="button"
                key={option.id}
                className={mode === option.id ? 'is-selected' : ''}
                aria-pressed={mode === option.id}
                disabled={busy}
                onClick={() => changeMode(option.id)}
              >{option.label}</button>
            ))}
          </div>
        </div>

        {mode === 'single' ? (
          <div className="ef-sfx-single-form">
            <div className="ef-field">
              <span className="ef-field-label">SOUND DESCRIPTION</span>
              <PromptCard
                prompt={singlePrompt}
                onPromptChange={setSinglePrompt}
                maxLength={PROMPT_MAX}
                placeholder="Describe the exact source, material, action, perspective and ending…"
                enhancerKey="enhancer-sfx-single"
                targetModel={`Suno Sounds ${modelLabel(model)}`}
                mediaKind="audio"
                purpose="single-sfx"
                onSpend={onSpend}
              />
            </div>
            <ChipField label="LOOP" options={['Off', 'On']} selected={loop ? 'On' : 'Off'} onSelect={(next) => setLoop(next === 'On')} />
            {renderAdvanced()}
          </div>
        ) : (
          <div className="ef-sfx-video-workspace">
            <section className="ef-sfx-source-column" aria-labelledby="ef-sfx-source-title">
              <div className="ef-primary-media-heading">
                <span id="ef-sfx-source-title" className="ef-field-label">VIDEO SOURCE</span>
                <span>{sourceAnchor ? 'TRIMMED TIMELINE CLIP' : 'VISUAL CONTEXT'}</span>
              </div>
              <VideoSourcePanel
                source={source}
                onPick={(file) => { void pickVideoSource(file) }}
                onGrab={() => { void grabVideoSource() }}
                grabPending={sourceGrabPending}
                disabled={busy}
                title="Choose a clip for Foley analysis"
                description="Upload a video, or Grab the exact trimmed source range under the Resolve playhead."
                groupLabel="Choose the source video for Auto Foley"
                grabLabel="Grab trimmed clip"
              />
              <p className="ef-sfx-video-disclosure">
                EasyField samples ordered visual frames for AI direction. Suno receives only the reviewed sound prompt—not the source video.
              </p>
            </section>
            <section className="ef-sfx-direction-column" aria-label="Auto Foley planning method">
              <div className="ef-sfx-guidance-picker">
                <div className="ef-sfx-guidance-head">
                  <span className="ef-field-label">PLANNING METHOD</span>
                  <small>{activeGuidance.summary}</small>
                </div>
                <div className="ef-setting-segmented ef-sfx-guidance-segmented" role="group" aria-label="Auto Foley planning method">
                  {FOLEY_GUIDANCE_MODES.map((option) => (
                    <button
                      type="button"
                      key={option.id}
                      className={foleyGuidance === option.id ? 'is-selected' : ''}
                      aria-pressed={foleyGuidance === option.id}
                      disabled={busy}
                      onClick={() => changeFoleyGuidance(option.id)}
                    >{option.label}</button>
                  ))}
                </div>
              </div>

              {foleyGuidance === 'guided' ? (
                <div className="ef-field">
                  <span className="ef-field-label">FOLEY DIRECTION</span>
                  <PromptCard
                    prompt={foleyDirection}
                    onPromptChange={changeFoleyDirection}
                    maxLength={FOLEY_DIRECTION_MAX}
                    placeholder="Tell the Foley planner what to prioritize or omit…"
                    enhancerKey="enhancer-sfx-foley"
                    targetModel="EasyField Auto Foley planner"
                    mediaKind="audio"
                    purpose="foley-direction"
                    references={videoReferences}
                    contextKey={`guided:${source?.id ?? 'no-video'}`}
                    onSpend={onSpend}
                  />
                </div>
              ) : (
                <div className="ef-sfx-full-auto" role="note">
                  <span className="ef-sfx-full-auto-icon" aria-hidden="true"><Icon glyph="spark" size={14} /></span>
                  <span>
                    <strong>Automatic scene reading</strong>
                    <small>EasyField identifies the visible actions, timing and useful Foley. You still review every event before any sound is generated.</small>
                  </span>
                </div>
              )}

              <div className="ef-sfx-context-note"><Icon glyph="playhead" size={11} /> Analysis creates an editable event list. No sound is generated until you approve events.</div>
            </section>
          </div>
        )}

        {mode === 'foley' && foleySummary && (
          <FoleyEventList
            summary={foleySummary}
            events={foleyEvents}
            disabled={busy}
            onToggle={(id) => setFoleyEvents((current) => current.map((event) => event.id === id ? { ...event, approved: !event.approved } : event))}
            onPromptChange={updateFoleyPrompt}
            onGenerate={(id) => { void generateFoleyEvents([id]) }}
            onPlace={(id) => { void placeFoleyEvent(id) }}
            onAnalyzeAgain={() => { void analyzeFoley() }}
          />
        )}

        {foleyAnalyzing && (
          <div className="ef-gen-block ef-sfx-analysis-progress" role="status" aria-live="polite">
            <div className="ef-audio-wave" aria-hidden="true">{Array.from({ length: 28 }, (_, index) => <span key={index} style={{ animationDelay: `${index * 0.05}s` }} />)}</div>
            <span className="ef-gen-caption">ANALYZING ORDERED VIDEO FRAMES…</span>
            <button type="button" className="ef-generation-exit-action" onClick={() => analysisAbortRef.current?.abort()}>Cancel analysis</button>
          </div>
        )}

        {(phase === 'generating' || foleyGenerating) && (
          <>
            <div className="ef-gen-block" role="status" aria-live="polite" aria-label={foleyGenerating ? 'Generating approved Foley events' : 'Generating sound effect'}>
              <div className="ef-audio-wave" aria-hidden="true">{Array.from({ length: 28 }, (_, index) => <span key={index} style={{ animationDelay: `${index * 0.05}s` }} />)}</div>
              <span className="ef-gen-caption">{foleyGenerating ? `GENERATING ${activeFoleyIdsRef.current.length} APPROVED EVENT${activeFoleyIdsRef.current.length === 1 ? '' : 'S'}…` : 'GENERATING SOUND…'}</span>
            </div>
            <GenerationCancelControl job={generation.job} onExit={exitGeneration} noun={foleyGenerating ? 'Foley generation' : 'sound generation'} />
          </>
        )}

        {phase === 'done' && results.length > 0 && mode !== 'foley' && (
          <div className="ef-done-block" role="region" aria-label={`${results.length} generated sound effects`}>
            <div className="ef-result-review-head">
              <span><strong>Choose sounds</strong><small>Preview first. Only selected sounds will be placed.</small></span>
              <em>{selectedIds.length} / {results.length}</em>
            </div>
            <div className="ef-music-list">
              {results.map((result, index) => (
                <div className={`ef-audio-result ef-result-choice${selectedIds.includes(result.id) ? ' is-selected' : ''}`} key={result.id}>
                  <div className="ef-audio-meta">
                    <span className="ef-audio-name">Sound {index + 1}</span>
                    <span className="ef-audio-sub">Suno Sounds {modelLabel(model)} · {loop ? 'loop' : 'one-shot'}</span>
                  </div>
                  <audio className="ef-audio-player" src={result.url} controls aria-label={`Preview generated sound ${index + 1}`} />
                  <button
                    type="button"
                    className="ef-result-select"
                    aria-label={`${selectedIds.includes(result.id) ? 'Deselect' : 'Select'} sound ${index + 1} for timeline placement`}
                    aria-pressed={selectedIds.includes(result.id)}
                    onClick={() => setSelectedIds((current) => current.includes(result.id) ? current.filter((id) => id !== result.id) : [...current, result.id])}
                  >{selectedIds.includes(result.id) ? '✓' : '+'}</button>
                </div>
              ))}
            </div>
            <div className="ef-charged">{formatCharged(charged)}</div>
            <div className="ef-result-actions">
              <button type="button" className="ef-ghost-btn" onClick={() => setPhase('form')}>↺ Create another</button>
              <button
                type="button"
                className="ef-send-btn"
                disabled={!selectedIds.length}
                onClick={() => sendToTimeline(
                  results.filter((result) => selectedIds.includes(result.id)).map((result, index) => ({ url: result.url, name: `Sound effect ${index + 1}` })),
                  'audio',
                  toast,
                )}
              >{selectedIds.length ? `Place ${selectedIds.length} selected` : 'Select to place'}</button>
            </div>
          </div>
        )}
      </div>

      {((mode !== 'foley' && phase === 'form') || mode === 'foley') && (
        <footer className="ef-create-footer" aria-label="Sound-effect workflow summary">
          {mode === 'foley' && !foleySummary
            ? <span className="ef-price"><span className="ef-price-label">AI ANALYSIS</span><span className="ef-spacer" /><span className="ef-price-value">LIVE BILLING</span></span>
            : mode === 'foley' && pendingFoley.length === 0
              ? <span className="ef-price"><span className="ef-price-label">REVIEW</span><span className="ef-spacer" /><span className="ef-price-value">{approvedFoley.length ? 'GENERATED' : 'NO EVENTS SELECTED'}</span></span>
              : <PriceEstimate estimate={estimate} />}
          <div className={`ef-create-footer-message ${error || spendBlocked || (mode === 'single' && !bpmValid) ? 'is-error' : !connected || (mode === 'single' && standardValidation) || (mode === 'foley' && (!sourceReady || foleyGuidanceValidation)) ? 'is-help' : 'is-ready'}`} role={error || spendBlocked || (mode === 'single' && !bpmValid) ? 'alert' : 'status'} aria-live="polite">
            {error
              ? `✕ ${error}`
              : !connected
                ? 'Connect EasyField Cloud to analyze or generate sound'
                : mode === 'foley'
                  ? !sourceReady
                    ? 'Upload a video or Grab a trimmed timeline clip'
                    : foleyGuidanceValidation
                      ? foleyGuidanceValidation
                    : !foleySummary
                      ? foleyGuidance === 'auto'
                        ? 'Ready for full-auto analysis · review every timed event before paid generation'
                        : 'Ready to analyze with your direction · review every timed event before paid generation'
                      : pendingFoley.length
                        ? `${pendingFoley.length} approved event${pendingFoley.length === 1 ? '' : 's'} ready · one provider request per event`
                        : 'Review complete · generated events remain available above'
                  : standardValidation
                    ? standardValidation
                    : spendBlocked
                      ? spendApproval.reason
                      : 'One Suno Sounds request · provider-managed output length'}
          </div>
          <button
            type="button"
            className="ef-generate ef-create-footer-action"
            onClick={() => {
              if (mode === 'foley') {
                if (!foleySummary) void analyzeFoley()
                else if (pendingFoley.length) void generateFoleyEvents(pendingFoley.map((event) => event.id))
              } else {
                void generateSound()
              }
            }}
            disabled={mode === 'foley' ? foleySummary ? !canGenerateFoley : !canAnalyze : !canGenerateStandard}
          >
            <Icon glyph="spark" color="#0E0E13" size={13} /> {mode === 'foley'
              ? !foleySummary
                ? foleyAnalyzing
                  ? 'Analyzing…'
                  : foleyGuidance === 'auto'
                    ? 'Analyze automatically'
                    : 'Analyze with direction'
                : pendingFoley.length ? `Generate ${pendingFoley.length} approved` : 'All generated'
              : 'Generate sound'}
          </button>
        </footer>
      )}
    </div>
  )
}
