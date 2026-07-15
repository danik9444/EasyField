import { useEffect, useRef, useState } from 'react'
import { Icon } from '../icons'
import { Dropdown } from '../components/Dropdown'
import { ChipField } from '../components/ChipField'
import { PriceEstimate } from '../components/PriceEstimate'
import { PromptCard } from '../components/PromptCard'
import { GenerationCancelControl, useGenerationJobControl } from '../components/GenerationCancelControl'
import { runMusic, isConnected, isGenerationExit } from '../services/run'
import { sendToTimeline } from '../services/timeline'
import { addCreations } from '../data/creations'
import { musicRunEstimate, resolveCharged, formatCharged } from '../data/pricing'
import { loadValue, saveValue } from '../data/prefs'
import { MUSIC_MODEL_META } from '../data/modelPresentation'
import { getSpendApproval } from '../services/spendGuard'
import { loadSettings } from '../settings'
import { promptCharacterCount } from '../data/promptLimits'

// Suno cloud generation contract. Verified 2026-07-06.
const SUNO_VERSIONS = [
  { id: 'V5_5', label: 'v5.5' },
  { id: 'V5', label: 'v5' },
  { id: 'V4_5PLUS', label: 'v4.5+' },
  { id: 'V4_5', label: 'v4.5' },
  { id: 'V4_5ALL', label: 'v4.5 All' },
  { id: 'V4', label: 'v4' },
]
const MODES = ['Simple', 'Custom']
const TOGGLE = ['Off', 'On']
const VOCAL_GENDERS = ['Any', 'Male', 'Female']
const SLIDERS = [
  { key: 'styleWeight', label: 'STYLE WEIGHT' },
  { key: 'weirdness', label: 'WEIRDNESS' },
  { key: 'audioWeight', label: 'AUDIO WEIGHT' },
]
const PREFS_KEY = 'create-music'
const DEFAULT_PROMPT = 'Dreamy lo-fi hip-hop with warm vinyl crackle and a mellow night-drive mood'

type Phase = 'form' | 'generating' | 'done'

interface CreateMusicProps {
  onBack: () => void
  toast: (msg: string) => void
  onSpend: (credits: number) => void
}

interface MusicPrefs {
  version?: string
  mode?: string
  instrumental?: string
  prompt?: string
  style?: string
  title?: string
  negativeTags?: string
  vocalGender?: string
  sliders?: Record<string, number>
}

function loadMusicState(): MusicPrefs {
  try {
    const raw = loadValue(PREFS_KEY)
    return raw ? (JSON.parse(raw) as MusicPrefs) : {}
  } catch {
    return {}
  }
}

const versionLabel = (id: string) => SUNO_VERSIONS.find((v) => v.id === id)?.label ?? id

export function CreateMusic({ onBack, toast, onSpend }: CreateMusicProps) {
  const saved = useRef(loadMusicState()).current
  const [phase, setPhase] = useState<Phase>('form')
  const [charged, setCharged] = useState<number | null>(null)
  const [version, setVersion] = useState(() =>
    SUNO_VERSIONS.some((v) => v.id === saved.version) ? saved.version! : 'V5_5',
  )
  const [mode, setMode] = useState(() => (MODES.includes(saved.mode ?? '') ? saved.mode! : 'Simple'))
  const [instrumental, setInstrumental] = useState(() => (TOGGLE.includes(saved.instrumental ?? '') ? saved.instrumental! : 'Off'))
  const [prompt, setPrompt] = useState(saved.prompt ?? DEFAULT_PROMPT)
  const [style, setStyle] = useState(saved.style ?? '')
  const [title, setTitle] = useState(saved.title ?? '')
  const [negativeTags, setNegativeTags] = useState(saved.negativeTags ?? '')
  const [vocalGender, setVocalGender] = useState(() => (VOCAL_GENDERS.includes(saved.vocalGender ?? '') ? saved.vocalGender! : 'Any'))
  const [sliders, setSliders] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {}
    SLIDERS.forEach((s) => {
      const v = saved.sliders?.[s.key]
      init[s.key] = typeof v === 'number' && v >= 0 && v <= 1 ? v : 0.5
    })
    return init
  })
  const [tracks, setTracks] = useState<{ id: string; url: string }[]>([])
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const generation = useGenerationJobControl()
  useEffect(() => {
    saveValue(
      PREFS_KEY,
      JSON.stringify({ version, mode, instrumental, prompt, style, title, negativeTags, vocalGender, sliders } satisfies MusicPrefs),
    )
  }, [version, mode, instrumental, prompt, style, title, negativeTags, vocalGender, sliders])

  const custom = mode === 'Custom'
  const isInstrumental = instrumental === 'On'
  const setSlider = (key: string, value: number) => setSliders((prev) => ({ ...prev, [key]: value }))

  const generate = async () => {
    setError(null)
    if (promptOverLimit || styleOverLimit || titleOverLimit) {
      setError('Shorten the highlighted Suno fields to the selected model version limits before composing.')
      return
    }
    setSelectedTrackIds([])
    setPhase('generating')
    const controller = generation.begin()
    try {
      const res = await runMusic(
        { version, mode, instrumental: isInstrumental, prompt, style, title, negativeTags, vocalGender, sliders },
        { signal: controller.signal, onJobCreated: generation.attachJob },
      )
      if (controller.signal.aborted) return
      if (!res.urls.length) {
        setError('No track was returned — please try again.')
        setPhase('form')
        return
      }
      const c = res.credits ?? resolveCharged(musicRunEstimate(version))
      setCharged(c)
      onSpend(c ?? 0)
      setTracks(res.urls.map((url, i) => ({ id: `trk-${i}`, url })))
      addCreations(res.urls.map((url) => ({ kind: 'audio', url, model: `Suno ${versionLabel(version)}`, prompt: title || prompt.slice(0, 80), meta: isInstrumental ? 'instrumental' : 'song' })))
      setPhase('done')
    } catch (e) {
      if (controller.signal.aborted || isGenerationExit(e)) {
        setPhase('form')
        return
      }
      setError(e instanceof Error ? e.message : String(e))
      setPhase('form')
    } finally {
      generation.finish(controller)
    }
  }

  const exitGeneration = () => {
    const outcome = generation.exit()
    if (!outcome) return
    setPhase('form')
    toast(outcome === 'backgrounded'
      ? 'Music generation continues in Activity · the tracks will be saved to Library'
      : 'Music generation cancelled')
  }

  const promptMax = custom ? (version === 'V4' ? 3_000 : 5_000) : 500
  const styleMax = version === 'V4' ? 200 : 1_000
  const titleMax = 80
  const negativeTagsMax = 200
  const promptOverLimit = promptCharacterCount(prompt) > promptMax
  const styleOverLimit = custom && promptCharacterCount(style) > styleMax
  const titleOverLimit = custom && promptCharacterCount(title) > titleMax
  const negativeTagsOverLimit = custom && promptCharacterCount(negativeTags) > negativeTagsMax
  const fieldsOverLimit = promptOverLimit || styleOverLimit || titleOverLimit || negativeTagsOverLimit
  const versionOptions = SUNO_VERSIONS.map((v) => v.label)
  const connected = isConnected()
  const estimate = musicRunEstimate(version)
  const spendApproval = getSpendApproval(estimate, loadSettings().spendLimit)
  const spendBlocked = connected && !spendApproval.approved

  return (
    <div className="ef-screen ef-legacy-workspace ef-create-music-screen">
      <div className="ef-sub-header">
        <button type="button" className="ef-back" onClick={onBack} aria-label="Back to tools">‹</button>
        <span className="ef-sub-title">Create Music</span>
        <span className="ef-spacer" />
        <span className="ef-model-badge">SUNO</span>
      </div>

      <div className="ef-scroll ef-create-scroll">
        {phase === 'form' && (
          <div className="ef-audio-monitor-empty" role="status">
            <span className="ef-audio-monitor-label">SCORE MONITOR · TWO TAKES</span>
            <div className="ef-audio-monitor-wave" aria-hidden="true">{Array.from({ length: 34 }, (_, index) => <i key={index} style={{ height: `${18 + ((index * 17) % 64)}%` }} />)}</div>
            <strong>Your score will appear here</strong>
            <small>Original duration is preserved; placement is always reviewed separately.</small>
          </div>
        )}
        <div className="ef-field">
          <span className="ef-field-label">MODEL</span>
          <Dropdown
            options={versionOptions}
            selected={versionLabel(version)}
            onSelect={(label) => setVersion(SUNO_VERSIONS.find((v) => v.label === label)?.id ?? version)}
            label="Suno model"
            align="left"
            variant="field"
            optionMeta={MUSIC_MODEL_META}
            searchable={false}
          />
        </div>

        <ChipField label="MODE" options={MODES} selected={mode} onSelect={setMode} chipClassName="ef-style-chip" />
        <ChipField label="INSTRUMENTAL" options={TOGGLE} selected={instrumental} onSelect={setInstrumental} />

        <div className="ef-field">
          <div className="ef-ref-header">
            <span className="ef-field-label">{custom ? (isInstrumental ? 'DESCRIPTION' : 'LYRICS') : 'SONG DESCRIPTION'}</span>
          </div>
          <PromptCard
            prompt={prompt}
            onPromptChange={setPrompt}
            maxLength={promptMax}
            placeholder={custom && !isInstrumental ? 'Write the lyrics…' : 'Describe the song…'}
            enhancerKey="enhancer-music"
            targetModel={`Suno ${versionLabel(version)}`}
            mediaKind="audio"
            purpose="music"
            onSpend={onSpend}
          />
        </div>

        {custom && (
          <>
            <div className="ef-field">
              <div className="ef-ref-header">
                <span className="ef-field-label">STYLE</span>
                <span className={`ef-ref-count${styleOverLimit ? ' is-over-limit' : ''}`}>{promptCharacterCount(style).toLocaleString()} / {styleMax.toLocaleString()}</span>
              </div>
              <input
                className="ef-text-input"
                placeholder="e.g. dreamy lo-fi, warm, mellow…"
                value={style}
                aria-invalid={styleOverLimit}
                onChange={(e) => setStyle(e.target.value)}
              />
            </div>
            <div className="ef-field">
              <div className="ef-ref-header">
                <span className="ef-field-label">TITLE</span>
                <span className={`ef-ref-count${titleOverLimit ? ' is-over-limit' : ''}`}>{promptCharacterCount(title).toLocaleString()} / {titleMax}</span>
              </div>
              <input
                className="ef-text-input"
                placeholder="Track title…"
                value={title}
                aria-invalid={titleOverLimit}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            {!isInstrumental && (
              <ChipField label="VOCAL GENDER" options={VOCAL_GENDERS} selected={vocalGender} onSelect={setVocalGender} />
            )}
            <div className="ef-field">
              <div className="ef-ref-header">
                <span className="ef-field-label">EXCLUDE STYLES</span>
                <span className={`ef-ref-count${negativeTagsOverLimit ? ' is-over-limit' : ''}`}>{promptCharacterCount(negativeTags).toLocaleString()} / {negativeTagsMax}</span>
              </div>
              <input
                className="ef-text-input"
                placeholder="e.g. heavy metal, aggressive…"
                value={negativeTags}
                aria-invalid={negativeTagsOverLimit}
                onChange={(e) => setNegativeTags(e.target.value)}
              />
            </div>
            {SLIDERS.map((s) => (
              <div className="ef-field" key={s.key}>
                <div className="ef-ref-header">
                  <span className="ef-field-label">{s.label}</span>
                  <span className="ef-spacer" />
                  <span className="ef-ref-count">{sliders[s.key].toFixed(2)}</span>
                </div>
                <input
                  className="ef-brush-slider"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={sliders[s.key]}
                  onChange={(e) => setSlider(s.key, Number(e.target.value))}
                  aria-label={s.label}
                />
              </div>
            ))}
          </>
        )}

        {phase === 'generating' && (
          <>
            <div className="ef-gen-block" role="status" aria-live="polite" aria-atomic="true" aria-label="Composing two music takes">
              <div className="ef-audio-wave" aria-hidden="true">
                {Array.from({ length: 28 }, (_, i) => (
                  <span key={i} style={{ animationDelay: `${i * 0.05}s` }} />
                ))}
              </div>
              <span className="ef-gen-caption">COMPOSING 2 TAKES…</span>
            </div>
            <GenerationCancelControl job={generation.job} onExit={exitGeneration} noun="music generation" />
          </>
        )}

        {phase === 'done' && tracks.length > 0 && (
          <div className="ef-done-block" role="region" aria-label={`${tracks.length} generated music takes`}>
            <div className="ef-result-review-head">
              <span><strong>Choose takes</strong><small>Listen first. Only approved takes will be placed.</small></span>
              <em>{selectedTrackIds.length} / {tracks.length}</em>
            </div>
            <div className="ef-music-list">
              {tracks.map((t, i) => (
                <div className={'ef-audio-result ef-result-choice' + (selectedTrackIds.includes(t.id) ? ' is-selected' : '')} key={t.id} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
                  <div className="ef-audio-meta">
                    <span className="ef-audio-name">{title ? `${title} · Take ${i + 1}` : `Take ${i + 1}`}</span>
                    <span className="ef-audio-sub">Suno {versionLabel(version)}{isInstrumental ? ' · instrumental' : ''}</span>
                  </div>
                  <audio
                    className="ef-audio-player"
                    src={t.url}
                    controls
                    aria-label={`Preview ${title ? `${title}, take ${i + 1}` : `music take ${i + 1}`}`}
                    style={{ width: '100%' }}
                  />
                  <button
                    type="button"
                    className="ef-result-select"
                    aria-label={`${selectedTrackIds.includes(t.id) ? 'Deselect' : 'Select'} take ${i + 1} for timeline placement`}
                    aria-pressed={selectedTrackIds.includes(t.id)}
                    onClick={() => setSelectedTrackIds((current) => current.includes(t.id) ? current.filter((id) => id !== t.id) : [...current, t.id])}
                  >
                    {selectedTrackIds.includes(t.id) ? '✓' : '+'}
                  </button>
                </div>
              ))}
            </div>
            <div className="ef-charged">{formatCharged(charged)}</div>
            <div className="ef-result-actions">
              <button type="button" className="ef-ghost-btn" onClick={() => setPhase('form')}>↺ Create another</button>
              <button
                type="button"
                className="ef-send-btn"
                disabled={selectedTrackIds.length === 0}
                onClick={() => sendToTimeline(
                  tracks.flatMap((t, i) => selectedTrackIds.includes(t.id)
                    ? [{ url: t.url, name: title || `Suno track ${i + 1}` }]
                    : []),
                  'audio',
                  toast,
                )}
              >
                {selectedTrackIds.length ? `Place ${selectedTrackIds.length} selected` : 'Select to place'}
              </button>
            </div>
          </div>
        )}
      </div>

      {phase === 'form' && (
        <footer className="ef-create-footer" aria-label="Music generation summary">
          <PriceEstimate estimate={estimate} />
          <div className={`ef-create-footer-message ${error || spendBlocked || fieldsOverLimit ? 'is-error' : connected ? 'is-ready' : 'is-help'}`} role={error || spendBlocked || fieldsOverLimit ? 'alert' : 'status'} aria-live="polite">
            {error
              ? `✕ ${error}`
              : fieldsOverLimit
                ? `✕ Suno ${versionLabel(version)} field limit exceeded · shorten the highlighted text`
              : !connected
                ? 'Connect EasyField Cloud to compose'
                : spendBlocked
                  ? `✕ ${spendApproval.reason}`
                  : 'Creates two full-length takes · no automatic retiming'}
          </div>
          <button type="button" className="ef-generate ef-create-footer-action" onClick={generate} disabled={!connected || !spendApproval.approved || fieldsOverLimit}>
            <Icon glyph="spark" color="#0E0E13" size={13} /> Compose 2 takes
          </button>
        </footer>
      )}
    </div>
  )
}
