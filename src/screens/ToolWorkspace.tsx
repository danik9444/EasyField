import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { Icon } from '../icons'
import type { MediaKind, ModelDefinition, ToolId } from '../core/contracts'
import { TOOL_BY_ID } from '../data/toolDefinitions'
import { modelsForTool } from '../data/validatedModels'
import { ModelBrowser } from '../components/ModelBrowser'
import { PromptCard } from '../components/PromptCard'
import { BeatAnalysisResult } from '../components/BeatAnalysisResult'
import { LibraryPickerButton } from '../components/LibraryPicker'
import { host } from '../services/host'
import { resolve } from '../services/resolve'
import { prepareJobLedger, startJob } from '../services/jobCenter'
import {
  BeatDetectionError,
  detectBeats,
  getBeatRuntimeStatus,
  type BeatDetectionResult,
  type BeatRuntimeStatus,
} from '../services/beatDetection'
import type { Creation, CreationKind } from '../data/creations'
import { copyLibraryCreationForWorkspace } from '../services/librarySelection'
import { transcriptFileName, type EasyFieldTranscriptDocument } from '../data/transcript'
import { promptCharacterCount } from '../data/promptLimits'

interface ToolWorkspaceProps {
  toolId: ToolId
  onBack: () => void
  toast: (message: string) => void
  onToggleWindowMode: () => void
  windowMode: 'compact' | 'expanded'
}

interface WorkspaceDraft {
  recipeId: string
  modelId?: string
  prompt: string
  scope: string
  advanced: boolean
  rightsConfirmed: boolean
}

interface WorkspaceSource {
  name: string
  kind: MediaKind
  file?: File
  blobUrl?: string
}

type BeatPhase = 'idle' | 'analyzing' | 'complete' | 'error'

const ACCEPT_BY_KIND: Record<MediaKind, string[]> = {
  image: ['image/*'],
  video: ['video/*'],
  audio: ['audio/*'],
  document: ['.pdf', '.txt', '.md', '.rtf', '.doc', '.docx', '.fountain', '.fdx'],
  transcript: ['.srt', '.vtt', '.txt', '.json'],
}

const EXTENSIONS_BY_KIND: Record<MediaKind, string[]> = {
  image: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tif', 'tiff', 'heic', 'avif'],
  video: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mxf'],
  audio: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'aiff', 'aif'],
  document: ['pdf', 'txt', 'md', 'rtf', 'doc', 'docx', 'fountain', 'fdx'],
  transcript: ['srt', 'vtt', 'txt', 'json'],
}

const PROMPT_PLACEHOLDERS: Partial<Record<ToolId, string>> = {
  broll: 'Describe the story beat or coverage you need…',
  storyboard: 'Paste a script or describe the sequence…',
  avatar: 'Describe the performance and expression…',
  angles: 'Describe the new camera angle…',
  extend: 'Describe how the shot continues after its final frame…',
  transition: 'Describe how the two shots should connect…',
  captions: 'Describe the caption style and emphasis…',
  sfx: 'Describe the sound or Foley treatment…',
  transcribe: 'Optional vocabulary, names or language notes…',
  beat: 'Optional marker density or musical section notes…',
  culling: 'Optional notes about what makes a strong take…',
}

const AVATAR_PROMPT_MAX_BY_MODEL: Readonly<Record<string, number>> = {
  'Kling Avatar Pro': 5_000,
  'Kling Avatar Standard': 5_000,
  'OmniHuman 1.5': 300,
  InfiniteTalk: 5_000,
}

function requiredSourceLabel(toolId: ToolId, recipeId?: string): string {
  if (toolId === 'transition') return 'Two adjacent shots'
  if (toolId === 'avatar') return recipeId === 'lipsync' ? 'Video and audio' : 'Portrait and audio'
  if (toolId === 'storyboard') return recipeId === 'range' ? 'Selected timeline range' : 'Script or document'
  if (toolId === 'transcribe') return 'Audio or video'
  if (toolId === 'beat') return 'Audio file, video file or timeline audio'
  if (toolId === 'captions') return 'Transcript, audio or video'
  if (toolId === 'culling') return 'Bin, selected range or full project'
  if (toolId === 'sfx') return recipeId === 'single' ? 'No source required' : 'Video clip or selected timeline range'
  return 'Timeline selection or local media'
}

function sourceKindsForRecipe(toolId: ToolId, recipeId: string, fallback: MediaKind[]): MediaKind[] {
  if (toolId === 'avatar') return recipeId === 'lipsync' ? ['video', 'audio'] : ['image', 'audio']
  if (toolId === 'sfx') return recipeId === 'single' ? [] : ['video']
  return fallback
}

function compatibleModelsForRecipe(toolId: ToolId, recipeId: string, models: ModelDefinition[]): ModelDefinition[] {
  if (toolId === 'avatar') {
    const requiredKinds = recipeId === 'lipsync' ? (['video', 'audio'] as const) : (['image', 'audio'] as const)
    return models.filter((model) => requiredKinds.every((kind) => model.inputKinds.includes(kind)))
  }
  if (toolId === 'transcribe' && recipeId === 'local') return models.filter((model) => model.provider === 'local')
  if (toolId === 'transcribe' && recipeId === 'kie') return models.filter((model) => model.provider === 'kie')
  if (toolId === 'extend') {
    // Keep task-ID-only providers visible but disabled until the source comes
    // from a durable Library artifact carrying its original provider task ID.
    // Wan remains the documented external-clip continuation path.
    return models
  }
  return models
}

function requiredDirectionLabel(toolId: ToolId, recipeId: string): string | undefined {
  if (toolId === 'transition') return 'Describe the bridge'
  if (toolId === 'sfx' && recipeId === 'single') return 'Describe the sound effect'
  if (toolId === 'angles' && recipeId === 'custom') return 'Describe the camera angle'
  return undefined
}

function recipeUnavailableReason(toolId: ToolId, recipeId: string): string | undefined {
  if (toolId === 'extend' && recipeId === 'backward') {
    return 'No validated backward-extension adapter yet'
  }
  if (toolId === 'transcribe' && recipeId === 'kie') {
    return 'No verified Kie transcription adapter yet'
  }
  return undefined
}

function inferFileKind(file: File, acceptedKinds: MediaKind[]): MediaKind | undefined {
  const mime = file.type.toLowerCase()
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  const mimeKind = mime.startsWith('image/')
    ? 'image'
    : mime.startsWith('video/')
      ? 'video'
      : mime.startsWith('audio/')
        ? 'audio'
        : undefined
  if (mimeKind && acceptedKinds.includes(mimeKind)) return mimeKind
  return acceptedKinds.find((kind) => EXTENSIONS_BY_KIND[kind].includes(extension))
}

export function ToolWorkspace({ toolId, onBack, toast, onToggleWindowMode, windowMode }: ToolWorkspaceProps) {
  const tool = TOOL_BY_ID[toolId]
  const models = useMemo(() => modelsForTool(toolId), [toolId])
  const defaultDraft = useMemo<WorkspaceDraft>(() => ({
    recipeId: tool.recipes[0]?.id ?? 'custom',
    modelId: models[0]?.id,
    prompt: '',
    scope: toolId === 'culling' ? 'Selected bin' : toolId === 'extend' ? 'Forward' : 'Current selection',
    advanced: false,
    rightsConfirmed: false,
  }), [models, tool.recipes, toolId])
  const [draft, setDraft] = useState<WorkspaceDraft>(defaultDraft)
  const [sources, setSources] = useState<WorkspaceSource[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const [beatRuntime, setBeatRuntime] = useState<BeatRuntimeStatus | null>(null)
  const [beatPhase, setBeatPhase] = useState<BeatPhase>('idle')
  const [beatResult, setBeatResult] = useState<BeatDetectionResult | null>(null)
  const [beatError, setBeatError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const reviewRef = useRef<HTMLElement>(null)
  const beatAbortRef = useRef<AbortController | null>(null)
  const capturedBlobUrlsRef = useRef(new Set<string>())
  const linkedTranscriptRef = useRef<string | null>(null)

  useEffect(() => {
    let active = true
    void host.getState<WorkspaceDraft>('drafts', `default:${toolId}`).then((saved) => {
      if (!active) return
      const restored = saved ? { ...defaultDraft, ...saved } : defaultDraft
      const migratedRecipeId = toolId === 'sfx' && restored.recipeId === 'picture' ? 'foley' : restored.recipeId
      const migrated = migratedRecipeId === restored.recipeId ? restored : { ...restored, recipeId: migratedRecipeId }
      const recipeExists = tool.recipes.some((recipe) => recipe.id === migrated.recipeId)
      setDraft(!recipeExists || recipeUnavailableReason(toolId, migrated.recipeId) ? defaultDraft : migrated)
      setHydrated(true)
    })
    return () => { active = false }
  }, [defaultDraft, tool.recipes, toolId])

  useEffect(() => {
    if (!hydrated) return
    const timer = window.setTimeout(() => void host.setState('drafts', `default:${toolId}`, draft), 180)
    return () => window.clearTimeout(timer)
  }, [draft, hydrated, toolId])

  useEffect(() => {
    if (toolId !== 'beat') return
    const controller = new AbortController()
    setBeatRuntime(null)
    void getBeatRuntimeStatus(controller.signal).then(setBeatRuntime).catch((error) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setBeatRuntime({ ok: false, available: false, engine: 'librosa', code: 'BEAT_SERVICE_UNAVAILABLE', error: 'The local beat service is unavailable.' })
      }
    })
    return () => controller.abort()
  }, [toolId])

  useEffect(() => () => {
    beatAbortRef.current?.abort()
    for (const blobUrl of capturedBlobUrlsRef.current) URL.revokeObjectURL(blobUrl)
    capturedBlobUrlsRef.current.clear()
  }, [])

  const selectedRecipe = tool.recipes.find((recipe) => recipe.id === draft.recipeId) ?? tool.recipes[0]
  const compatibleModels = useMemo(() => compatibleModelsForRecipe(toolId, draft.recipeId, models), [draft.recipeId, models, toolId])
  const selectedModel = compatibleModels.find((model) => model.id === draft.modelId) ?? compatibleModels[0]
  const cloud = selectedModel?.provider === 'kie' || tool.privacy === 'cloud'
  const notesOnly = ['culling', 'transcribe', 'beat'].includes(toolId)
  const promptMediaKind = tool.category === 'image' ? 'image' : tool.category === 'video' ? 'video' : tool.category === 'audio' ? 'audio' : 'workflow'
  const acceptedKinds = useMemo(() => sourceKindsForRecipe(toolId, draft.recipeId, tool.sourceKinds), [draft.recipeId, tool.sourceKinds, toolId])
  const accept = useMemo(() => [...new Set(acceptedKinds.flatMap((kind) => ACCEPT_BY_KIND[kind]))].join(','), [acceptedKinds])
  const libraryKinds = useMemo(
    () => acceptedKinds.filter((kind): kind is CreationKind => kind === 'image' || kind === 'video' || kind === 'audio'),
    [acceptedKinds],
  )
  const sourceRequirement = requiredSourceLabel(toolId, draft.recipeId)
  const sourceReady = useMemo(() => {
    if (toolId === 'avatar') {
      const visualKind: MediaKind = draft.recipeId === 'lipsync' ? 'video' : 'image'
      return sources.some((source) => source.kind === visualKind) && sources.some((source) => source.kind === 'audio')
    }
    if (toolId === 'transition') return sources.length >= 2
    if (toolId === 'storyboard' && draft.recipeId === 'script') return sources.length > 0 || !!draft.prompt.trim()
    if (toolId === 'sfx' && draft.recipeId === 'single') return true
    return sources.length > 0
  }, [draft.prompt, draft.recipeId, sources, toolId])
  const directionRequirement = requiredDirectionLabel(toolId, draft.recipeId)
  const directionReady = !directionRequirement || !!draft.prompt.trim()
  const rightsReady = toolId !== 'avatar' || !!draft.rightsConfirmed
  const promptSupported = !(toolId === 'avatar' && selectedModel?.name === 'Volcengine Lip Sync')
  const promptMax = toolId === 'avatar'
    ? AVATAR_PROMPT_MAX_BY_MODEL[selectedModel?.name ?? ''] ?? 5_000
    : 8_000
  const promptOverLimit = promptSupported && promptCharacterCount(draft.prompt) > promptMax
  const ready = sourceReady && directionReady && rightsReady && !promptOverLimit
  const readyMessage = !sourceReady
    ? sourceRequirement
    : !directionReady
      ? (directionRequirement ?? 'Direction required')
      : promptOverLimit
        ? `Shorten direction to ${promptMax.toLocaleString()} characters for ${selectedModel?.name ?? 'this model'}`
        : !rightsReady
          ? 'Rights confirmation required'
          : 'Ready to review'
  const beatActionReady = toolId === 'beat' && ready && beatRuntime?.available === true && beatPhase !== 'analyzing'
  const actionReady = toolId === 'beat' ? beatActionReady : ready
  const actionMessage = toolId !== 'beat'
    ? readyMessage
    : !sourceReady
      ? 'Choose audio or video'
      : beatRuntime == null
        ? 'Checking librosa runtime'
        : !beatRuntime.available
          ? 'librosa setup required'
          : beatPhase === 'analyzing'
            ? 'Analyzing locally'
            : beatResult
              ? `${beatResult.beats.length} beats ready to review`
              : 'Ready for local analysis'

  useEffect(() => {
    if (!compatibleModels.length || compatibleModels.some((model) => model.id === draft.modelId)) return
    setDraft((current) => ({ ...current, modelId: compatibleModels[0]?.id }))
  }, [compatibleModels, draft.modelId])

  useEffect(() => {
    if (ready || !reviewOpen) return
    setReviewOpen(false)
  }, [ready, reviewOpen])

  useEffect(() => {
    if (!reviewOpen) return
    const frame = window.requestAnimationFrame(() => {
      reviewRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
      reviewRef.current?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [reviewOpen])

  const releaseSource = (source: WorkspaceSource) => {
    if (!source.blobUrl || !capturedBlobUrlsRef.current.has(source.blobUrl)) return
    URL.revokeObjectURL(source.blobUrl)
    capturedBlobUrlsRef.current.delete(source.blobUrl)
  }

  const resetBeatAnalysis = () => {
    beatAbortRef.current?.abort()
    beatAbortRef.current = null
    setBeatPhase('idle')
    setBeatResult(null)
    setBeatError('')
    if (toolId === 'beat') setReviewOpen(false)
  }

  const replaceSources = (next: WorkspaceSource[]) => {
    setSources((current) => {
      current.forEach(releaseSource)
      return next
    })
    resetBeatAnalysis()
  }

  useEffect(() => {
    if (toolId !== 'captions') {
      linkedTranscriptRef.current = null
      return
    }

    let active = true
    void (async () => {
      const incoming = await host.getState<{ transcriptId?: string }>('drafts', 'captions:incoming-transcript')
      const transcriptId = incoming?.transcriptId?.trim()
      if (!active || !transcriptId || linkedTranscriptRef.current === transcriptId) return

      const transcript = await host.getState<EasyFieldTranscriptDocument>('transcripts', transcriptId)
      if (!active || !transcript || transcript.kind !== 'easyfield-transcript') return

      const file = new File(
        [JSON.stringify(transcript, null, 2)],
        transcriptFileName(transcript, 'json'),
        { type: 'application/vnd.easyfield.transcript+json' },
      )
      linkedTranscriptRef.current = transcriptId
      setSources([{ name: file.name, kind: 'transcript', file }])
      toast('Transcript linked from Transcribe')
    })()

    return () => { active = false }
  }, [toast, toolId])

  const addFiles = (files: FileList | File[] | null) => {
    if (!files?.length) return
    const accepted = Array.from(files).flatMap((file) => {
      const kind = inferFileKind(file, acceptedKinds)
      return kind ? [{ name: file.name, kind, file }] : []
    })
    const rejectedCount = files.length - accepted.length
    if (accepted.length) {
      if (toolId === 'beat') replaceSources([accepted[0]])
      else setSources((current) => [...current, ...accepted].slice(0, 12))
    }
    if (rejectedCount) toast(`${rejectedCount} file${rejectedCount === 1 ? '' : 's'} skipped — choose ${sourceRequirement.toLowerCase()}`)
  }

  const addLibrarySources = async (selected: Creation[]) => {
    const files = await Promise.all(selected.map((creation) => copyLibraryCreationForWorkspace(creation)))
    addFiles(files)
  }

  const addTimelineSource = (source: WorkspaceSource) => {
    if (source.blobUrl) capturedBlobUrlsRef.current.add(source.blobUrl)
    if (toolId === 'beat') replaceSources([source])
    else setSources((current) => [...current, source].slice(0, 12))
  }

  const removeSource = (index: number) => {
    setSources((current) => {
      const removed = current[index]
      if (removed) releaseSource(removed)
      return current.filter((_, sourceIndex) => sourceIndex !== index)
    })
    resetBeatAnalysis()
  }

  const clearSources = () => {
    replaceSources([])
  }

  const useTimeline = async () => {
    if (!resolve.isBridgeConnected()) {
      toast('Resolve is not connected — choose local media instead')
      return
    }
    if (toolId === 'beat') {
      const result = await resolve.grabAudio()
      if (result.ok && result.blobUrl) addTimelineSource({ name: result.name || 'Timeline audio', kind: 'audio', blobUrl: result.blobUrl })
      else toast(result.error || 'Could not capture timeline audio')
      return
    }
    if (toolId === 'avatar') {
      const visualKind: MediaKind = draft.recipeId === 'lipsync' ? 'video' : 'image'
      const visualReady = sources.some((source) => source.kind === visualKind)
      if (!visualReady) {
        const result = draft.recipeId === 'lipsync' ? await resolve.grabClip() : await resolve.grabFrame()
        if (result.ok) addTimelineSource({ name: result.name || (visualKind === 'video' ? 'Timeline clip' : 'Playhead frame'), kind: visualKind, blobUrl: result.blobUrl })
        else toast(visualKind === 'video' ? 'Could not capture a timeline clip' : 'Could not capture a frame')
        return
      }
      const result = await resolve.grabAudio()
      if (result.ok) addTimelineSource({ name: result.name || 'Timeline audio', kind: 'audio', blobUrl: result.blobUrl })
      else toast('Could not capture timeline audio')
      return
    }
    if (toolId === 'transition') {
      const result = await resolve.grabFrame()
      if (result.ok) addTimelineSource({ name: result.name || `Transition frame ${sources.length + 1}`, kind: 'image', blobUrl: result.blobUrl })
      else toast('Could not capture a transition frame')
      return
    }
    if (acceptedKinds.includes('audio') && !acceptedKinds.includes('video')) {
      const result = await resolve.grabAudio()
      if (result.ok) {
        if (result.blobUrl) capturedBlobUrlsRef.current.add(result.blobUrl)
        replaceSources([{ name: result.name || 'Timeline audio', kind: 'audio', blobUrl: result.blobUrl }])
      }
      else toast('Could not capture timeline audio')
      return
    }
    if (acceptedKinds.includes('video')) {
      const result = await resolve.grabClip()
      if (result.ok) {
        if (result.blobUrl) capturedBlobUrlsRef.current.add(result.blobUrl)
        replaceSources([{ name: result.name || 'Timeline clip', kind: 'video', blobUrl: result.blobUrl }])
      }
      else toast('Could not capture timeline clip')
      return
    }
    const result = await resolve.grabFrame()
    if (result.ok) {
      if (result.blobUrl) capturedBlobUrlsRef.current.add(result.blobUrl)
      replaceSources([{ name: result.name || 'Playhead frame', kind: 'image', blobUrl: result.blobUrl }])
    }
    else toast('Could not capture a frame')
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
    addFiles(event.dataTransfer.files)
  }

  const review = () => {
    if (!ready) {
      toast(readyMessage)
      return
    }
    setReviewOpen(true)
  }

  const analyzeBeats = async () => {
    if (toolId !== 'beat' || !beatActionReady) {
      toast(actionMessage)
      return
    }
    const source = sources[0]
    if (!source) {
      toast('Choose audio or video first')
      return
    }
    beatAbortRef.current?.abort()
    const controller = new AbortController()
    beatAbortRef.current = controller
    await prepareJobLedger()
    const job = startJob({
      title: 'Beat Detection',
      subtitle: source.name,
      kind: 'audio',
      onCancel: () => controller.abort(),
    })
    try {
      await job.persisted
      job.update({ status: 'running', detail: 'Analyzing locally with librosa' })
      setBeatPhase('analyzing')
      setBeatError('')
      setReviewOpen(false)
      const media = source.file
        ?? (source.blobUrl ? await fetch(source.blobUrl, { signal: controller.signal }).then((response) => response.blob()) : null)
      if (!media) throw new BeatDetectionError('Select the source file again before analysis.', 'SOURCE_UNAVAILABLE')
      const result = await detectBeats(media, source.name, controller.signal)
      setBeatResult(result)
      setBeatPhase('complete')
      setReviewOpen(true)
      // Analysis has no Library artifact; the reviewed result stays on this screen.
      job.succeed(0, `${result.beats.length} beats ready to review`)
      toast(`${result.beats.length} beats detected locally`)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        job.fail(error)
        setBeatPhase('idle')
        return
      }
      const message = error instanceof Error ? error.message : 'Beat analysis failed.'
      if (error instanceof BeatDetectionError && error.code === 'BEAT_RUNTIME_MISSING') {
        setBeatRuntime({ ok: false, available: false, engine: 'librosa', code: error.code, error: message, setupGuide: error.setupGuide })
      }
      job.fail(error)
      setBeatError(message)
      setBeatPhase('error')
      toast(message)
    } finally {
      if (beatAbortRef.current === controller) beatAbortRef.current = null
    }
  }

  const selectRecipe = (recipeId: string) => {
    const unavailableReason = recipeUnavailableReason(toolId, recipeId)
    if (unavailableReason) {
      toast(unavailableReason)
      return
    }
    const nextModels = compatibleModelsForRecipe(toolId, recipeId, models)
    setDraft((current) => ({
      ...current,
      recipeId,
      modelId: nextModels.some((model) => model.id === current.modelId) ? current.modelId : nextModels[0]?.id,
    }))
    setReviewOpen(false)
  }

  return (
    <div className="ef-screen ef-workspace" style={{ '--ef-tool-accent': tool.accent } as CSSProperties}>
      <header className="ef-workspace-header">
        <button type="button" className="ef-back-btn" onClick={onBack} aria-label="Back to tools">←</button>
        <span className="ef-workspace-icon" aria-hidden="true"><Icon glyph={tool.glyph} color={tool.accent} size={16} /></span>
        <span className="ef-workspace-heading">
          <small>{tool.workspace.toUpperCase()} · {tool.category.toUpperCase()}</small>
          <strong>{tool.name}</strong>
        </span>
        <span className="ef-spacer" />
        <span
          className="ef-draft-state"
          role="status"
          title="Recipe, model and direction autosave. Source media must be selected again after a restart."
        ><i aria-hidden="true" /> Draft autosave</span>
        <button type="button" className="ef-density-toggle" onClick={onToggleWindowMode} aria-label={`Switch to ${windowMode === 'compact' ? 'expanded' : 'compact'} view`}>
          {windowMode === 'compact' ? '↗' : '↙'}
        </button>
      </header>

      <div className="ef-workspace-scroll ef-scroll">
        <section className="ef-workspace-intro ef-workspace-slot--intro">
          <span className="ef-workspace-kicker">{tool.category.toUpperCase()}</span>
          <h1>{tool.description}</h1>
          <p>{selectedRecipe?.description}. {toolId === 'beat' ? 'Analysis runs locally with librosa; every result is review-only until you explicitly apply it.' : 'Settings autosave locally; source media stays in this session until a durable execution adapter is connected.'}</p>
        </section>

        <aside className="ef-workspace-inspector" aria-label={`${tool.name} controls`}>
          <section className="ef-workspace-section ef-workspace-slot--recipes" aria-labelledby={`recipe-${toolId}`}>
            <div className="ef-section-heading"><span className="ef-section-number" aria-hidden="true">01</span><span id={`recipe-${toolId}`}>RECIPE</span><small>Start fast or go custom</small></div>
            <div className="ef-recipe-grid">
              {tool.recipes.map((recipe) => {
                const unavailableReason = recipeUnavailableReason(toolId, recipe.id)
                return (
                  <button
                    type="button"
                    key={recipe.id}
                    aria-pressed={draft.recipeId === recipe.id}
                    aria-disabled={!!unavailableReason}
                    aria-describedby={unavailableReason ? `${toolId}-${recipe.id}-status` : undefined}
                    className={'ef-recipe-card' + (draft.recipeId === recipe.id ? ' is-selected' : '') + (unavailableReason ? ' is-unavailable' : '')}
                    onClick={() => selectRecipe(recipe.id)}
                  >
                    <strong>{recipe.name}</strong><span>{recipe.description}</span>
                    {unavailableReason && <small id={`${toolId}-${recipe.id}-status`}>PLANNED · ADAPTER REQUIRED</small>}
                  </button>
                )
              })}
            </div>
          </section>

          <section className="ef-workspace-section ef-workspace-slot--intent">
            <div className="ef-section-heading"><span className="ef-section-number" aria-hidden="true">03</span><span id={`intent-${toolId}`}>{notesOnly ? 'NOTES & DIRECTION' : 'DIRECTION'}</span><small>{notesOnly ? 'Optional' : 'Prompt enhancer'}</small></div>
            {promptSupported ? (
              <PromptCard
                prompt={draft.prompt}
                onPromptChange={(prompt) => setDraft((current) => ({ ...current, prompt }))}
                maxLength={promptMax}
                placeholder={PROMPT_PLACEHOLDERS[toolId] ?? 'Describe the result you want…'}
                enhancerKey={`enhancer-${toolId}`}
                targetModel={selectedModel?.name ?? tool.name}
                mediaKind={promptMediaKind}
              />
            ) : (
              <div className="ef-anim-hint" role="note">
                Volcengine Lip Sync uses the selected video and audio directly; Kie does not expose a generation-prompt field for this model.
              </div>
            )}
          </section>

          {toolId === 'avatar' && (
            <section className="ef-workspace-section ef-workspace-slot--consent" aria-labelledby="avatar-rights-title">
              <div className="ef-section-heading"><span className="ef-section-number" aria-hidden="true">04</span><span id="avatar-rights-title">RIGHTS &amp; CONSENT</span><small>Required</small></div>
              <label className="ef-rights-check">
                <input
                  type="checkbox"
                  checked={!!draft.rightsConfirmed}
                  onChange={(event) => setDraft((current) => ({ ...current, rightsConfirmed: event.target.checked }))}
                />
                <span>
                  <strong>I have permission to use this person</strong>
                  <small>I confirm I hold the necessary rights and the subject has consented to this animation or lip-sync.</small>
                </span>
              </label>
            </section>
          )}

          <section className="ef-workspace-section ef-workspace-slot--model">
            <ModelBrowser models={compatibleModels} value={draft.modelId} onChange={(modelId) => setDraft((current) => ({ ...current, modelId }))} label={toolId === 'transcribe' ? 'Engine' : 'Model'} stepNumber={toolId === 'avatar' ? '05' : '04'} />
          </section>

          <section className="ef-workspace-section ef-workspace-slot--advanced">
            <button type="button" className="ef-advanced-toggle" aria-expanded={draft.advanced} onClick={() => setDraft((current) => ({ ...current, advanced: !current.advanced }))}>
              <span>Advanced controls</span><span>{draft.advanced ? '−' : '+'}</span>
            </button>
            {draft.advanced && (
              <div className="ef-advanced-panel">
                <label><span>Scope</span><input value={draft.scope} onChange={(event) => setDraft((current) => ({ ...current, scope: event.target.value }))} /></label>
                <div className="ef-advanced-facts">
                  <span>Timeline matching</span><strong>Resolution · FPS · Color</strong>
                  <span>Placement</span><strong>{tool.placement ? 'Review before apply' : 'Library / handoff'}</strong>
                </div>
              </div>
            )}
          </section>
        </aside>

        <section className="ef-workspace-section ef-workspace-slot--stage">
          <div className="ef-section-heading"><span className="ef-section-number" aria-hidden="true">02</span><span>SOURCE &amp; PREVIEW</span><small>{sourceReady ? 'Ready' : sourceRequirement}</small></div>
          <div
            className={'ef-source-stage' + (sources.length ? ' has-source' : '') + (dragActive ? ' is-dragging' : '')}
            onDragEnter={(event) => { event.preventDefault(); setDragActive(true) }}
            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
              setDragActive(false)
            }}
            onDrop={handleDrop}
            aria-label={`Source drop zone. Required: ${sourceRequirement}`}
          >
            <div className="ef-stage-toolbar" aria-hidden="true">
              <span><i /> SOURCE MONITOR</span>
              <span>{acceptedKinds.length === 0 ? 'NOT REQUIRED' : dragActive ? 'DROP TO ADD' : sources.length ? `${sources.length} LOADED` : 'EMPTY'}</span>
            </div>
            <div className="ef-stage-canvas">
              <span className="ef-stage-corner ef-stage-corner--tl" aria-hidden="true" />
              <span className="ef-stage-corner ef-stage-corner--tr" aria-hidden="true" />
              <span className="ef-stage-corner ef-stage-corner--bl" aria-hidden="true" />
              <span className="ef-stage-corner ef-stage-corner--br" aria-hidden="true" />
              <div className="ef-source-orb" aria-hidden="true"><Icon glyph={tool.glyph} color={tool.accent} size={24} /></div>
              <div className="ef-source-copy">
                <strong>{sources.length ? sourceReady ? `${sources.length} source${sources.length === 1 ? '' : 's'} ready` : `${sources.length} loaded · ${sourceRequirement} required` : sourceRequirement}</strong>
                <span>{acceptedKinds.length === 0 ? 'Generate directly from the prompt; no media will be uploaded.' : sources.length ? 'Review the selected media below. Source files must be selected again after a restart.' : dragActive ? 'Release to add these files.' : 'Drop media here, choose files, or capture the current Resolve context.'}</span>
              </div>
              {sources.length > 0 && (
                <div className="ef-workspace-source-list" aria-label="Selected source media">
                  {sources.map((source, index) => (
                    <span className="ef-workspace-source-chip" key={`${source.kind}-${source.name}-${index}`}>
                      <small>{source.kind}</small>
                      <strong title={source.name}>{source.name}</strong>
                      <button type="button" aria-label={`Remove source ${source.name}`} onClick={() => removeSource(index)}>×</button>
                    </span>
                  ))}
                  {sources.length > 1 && <button type="button" className="ef-workspace-source-clear" onClick={clearSources}>Clear all</button>}
                </div>
              )}
              {acceptedKinds.length > 0 && (
                <div className="ef-source-actions">
                  <button type="button" onClick={() => inputRef.current?.click()}>Choose files</button>
                  {libraryKinds.length > 0 && (
                    <LibraryPickerButton
                      kinds={libraryKinds}
                      max={toolId === 'beat' ? 1 : Math.max(0, 12 - sources.length)}
                      disabled={toolId !== 'beat' && sources.length >= 12}
                      onSelect={addLibrarySources}
                      className="ef-library-source-btn"
                      label="From Library"
                      ariaLabel={`Choose ${sourceRequirement.toLowerCase()} from Library`}
                      pickerTitle={`Choose ${sourceRequirement.toLowerCase()}`}
                      confirmLabel={toolId === 'beat' ? 'Use media' : 'Add media'}
                    />
                  )}
                  <button type="button" onClick={() => void useTimeline()}>Use timeline</button>
                </div>
              )}
            </div>
            <input
              ref={inputRef}
              type="file"
              accept={accept}
              multiple={toolId !== 'beat'}
              hidden
              onChange={(event) => {
                addFiles(event.target.files)
                event.target.value = ''
              }}
            />
          </div>
        </section>

        {toolId === 'beat' && beatRuntime && !beatRuntime.available && (
          <section className="ef-workspace-section ef-workspace-slot--review ef-beat-runtime-note" role="status" aria-live="polite">
            <strong>librosa runtime required</strong>
            <p>{beatRuntime.error || 'Install the managed local analysis pack to enable Beat Detection.'}</p>
            <code>{beatRuntime.setupGuide || 'plugin/python/README.md'}</code>
            <p>No global package install was attempted, and Resolve was not changed.</p>
          </section>
        )}

        {toolId === 'beat' && beatError && beatRuntime?.available && (
          <p className="ef-inline-warning ef-workspace-slot--review" role="alert">{beatError}</p>
        )}

        {reviewOpen && toolId === 'beat' && beatResult && (
          <section ref={reviewRef} tabIndex={-1} className="ef-review-panel ef-workspace-slot--review" aria-live="polite">
            <BeatAnalysisResult result={beatResult} sourceName={sources[0]?.name ?? 'Selected media'} mode={draft.recipeId === 'align' ? 'align' : 'markers'} />
          </section>
        )}

        {reviewOpen && toolId !== 'beat' && (
          <section ref={reviewRef} tabIndex={-1} className="ef-review-panel ef-workspace-slot--review" aria-live="polite">
            <div className="ef-review-head"><span>WORKFLOW REVIEW</span><strong>Review only · no job started</strong></div>
            <dl>
              <div><dt>Recipe</dt><dd>{selectedRecipe?.name}</dd></div>
              <div><dt>{toolId === 'transcribe' ? 'Engine' : 'Model'}</dt><dd>{selectedModel?.name ?? 'Adapter pending'}</dd></div>
              <div><dt>Source</dt><dd>{sources.length ? `${sources.length} selected · ${[...new Set(sources.map((source) => source.kind))].join(' + ')}` : draft.scope}</dd></div>
              {toolId === 'avatar' && <div><dt>Rights &amp; consent</dt><dd>Confirmed for this run</dd></div>}
              <div><dt>Cloud upload</dt><dd>{cloud ? 'Manifest + consent required' : 'No media leaves this Mac'}</dd></div>
              <div><dt>Timeline</dt><dd>{tool.placement ? 'Preview before apply · no ripple' : 'No automatic mutation'}</dd></div>
            </dl>
            <p className="ef-inline-warning" role="status">
              {selectedModel?.available
                ? `${tool.name} setup is complete, but its execution adapter is not connected in this build. No paid request or timeline change was made.`
                : 'This model is visible for planning, but execution stays disabled until its validated provider adapter is installed.'}
            </p>
          </section>
        )}
      </div>

      <footer className="ef-workspace-actionbar">
        <div className="ef-run-summary">
          <span className={'ef-privacy-chip ' + (cloud ? 'is-cloud' : 'is-local')}><i />{cloud ? 'Cloud manifest' : 'Local'}</span>
          <span className="ef-workspace-cost">{toolId === 'beat' ? 'On-device · no credits' : selectedModel && !selectedModel.available ? 'Adapter planned' : selectedModel?.priceCredits == null ? 'Live price at preflight' : `Estimate · ${selectedModel.priceCredits} credits`}</span>
          <span className={'ef-workspace-compact-status' + (actionReady ? ' is-ready' : '')}><i aria-hidden="true" />{actionMessage}</span>
        </div>
        <span className="ef-workspace-preflight"><i className={actionReady ? 'is-ready' : ''} aria-hidden="true" />{actionMessage}</span>
        <button
          type="button"
          className="ef-workspace-primary"
          disabled={!actionReady}
          aria-label={actionReady ? (toolId === 'beat' ? 'Analyze beats locally' : 'Review workflow') : `${toolId === 'beat' ? 'Beat analysis' : 'Review workflow'} unavailable: ${actionMessage}`}
          onClick={toolId === 'beat' ? () => void analyzeBeats() : review}
        >
          {toolId === 'beat' ? beatPhase === 'analyzing' ? 'Analyzing…' : beatResult ? 'Analyze again' : 'Analyze beats' : 'Review workflow'} <span aria-hidden="true">→</span>
        </button>
      </footer>
    </div>
  )
}
