import { useEffect, useRef, useState } from 'react'
import { Icon } from '../icons'
import { Dropdown } from '../components/Dropdown'
import { PriceEstimate } from '../components/PriceEstimate'
import { VoicePicker, type VoiceAuditionRunOptions } from '../components/VoicePicker'
import { GenerationCancelControl, useGenerationJobControl } from '../components/GenerationCancelControl'
import { runTts, runDialogue, isConnected, isGenerationExit } from '../services/run'
import { sendToTimeline } from '../services/timeline'
import { addCreation } from '../data/creations'
import { ttsRunEstimate, resolveCharged, formatCharged, formatEstimate } from '../data/pricing'
import {
  ELEVEN_MODELS,
  ELEVEN_VOICES,
  ELEVEN_LANGUAGES,
  TURBO_LANGUAGES,
  TTS_SLIDERS,
  DIALOGUE_STABILITY_VALUES,
  DEFAULT_DIALOGUE_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  AUDIO_TAGS,
  DEFAULT_TTS_MODEL,
  DEFAULT_VOICE,
  languageCode,
  languageLabel,
  modelKind,
  type DialogueSettings,
  type TtsSettings,
} from '../data/elevenLabsConfig'
import { loadValue, saveValue } from '../data/prefs'
import { VOICE_MODEL_META } from '../data/modelPresentation'
import { getSpendApproval } from '../services/spendGuard'
import { loadSettings } from '../settings'

const PREFS_KEY = 'voice-over'
const TEXT_MAX = 5000
const CONTEXT_MAX = 5000
const DIALOGUE_TEXT_MAX = 5000
const LINE_MAX = 800
const MAX_LINES = 12
const DEFAULT_TEXT = 'In a world shaped by imagination, every frame tells a story.'
const AUDITION_TEXT = 'Welcome to EasyField. Let\'s bring your story to life.'

type Phase = 'form' | 'generating' | 'done'

interface DialogueLine {
  id: string
  voice: string
  text: string
}

interface VoiceOverProps {
  onBack: () => void
  toast: (msg: string) => void
  onSpend: (credits: number) => void
}

interface VoicePrefs {
  model?: string
  settingsByModel?: Record<string, TtsModelState>
  dialogueSettings?: DialogueSettings
  // Legacy fields retained only for one-time local preference migration.
  voice?: string
  text?: string
  sliders?: Record<string, number>
  lines?: DialogueLine[]
  dialogueStability?: number
}

interface TtsModelState extends TtsSettings {
  voice: string
  text: string
}

function loadVoiceState(): VoicePrefs {
  try {
    const raw = loadValue(PREFS_KEY)
    return raw ? (JSON.parse(raw) as VoicePrefs) : {}
  } catch {
    return {}
  }
}

const modelLabel = (id: string) => ELEVEN_MODELS.find((m) => m.id === id)?.label ?? id
const voiceLabel = (id: string) => ELEVEN_VOICES.find((v) => v.id === id)?.label ?? id

const normalizeTtsState = (value?: Partial<TtsModelState>, modelId = DEFAULT_TTS_MODEL): TtsModelState => {
  const settings = { ...DEFAULT_TTS_SETTINGS }
  TTS_SLIDERS.forEach((slider) => {
    const candidate = value?.[slider.key as keyof TtsSettings]
    if (typeof candidate === 'number' && candidate >= slider.min && candidate <= slider.max) {
      ;(settings as unknown as Record<string, number>)[slider.key] = candidate
    }
  })
  return {
    ...settings,
    timestamps: typeof value?.timestamps === 'boolean' ? value.timestamps : settings.timestamps,
    previousText: typeof value?.previousText === 'string' ? value.previousText.slice(0, CONTEXT_MAX) : '',
    nextText: typeof value?.nextText === 'string' ? value.nextText.slice(0, CONTEXT_MAX) : '',
    languageCode:
      modelId === 'turbo-2-5' && TURBO_LANGUAGES.some((language) => language.code === value?.languageCode?.toLowerCase())
        ? value!.languageCode!.toLowerCase()
        : '',
    voice: ELEVEN_VOICES.some((voice) => voice.id === value?.voice) ? value!.voice! : DEFAULT_VOICE,
    text: typeof value?.text === 'string' ? value.text.slice(0, TEXT_MAX) : DEFAULT_TEXT,
  }
}

const normalizeDialogueSettings = (saved: VoicePrefs): DialogueSettings => {
  const stability = saved.dialogueSettings?.stability ?? saved.dialogueStability
  return {
    stability: stability === 0 || stability === 0.5 || stability === 1 ? stability : DEFAULT_DIALOGUE_SETTINGS.stability,
    languageCode:
      typeof saved.dialogueSettings?.languageCode === 'string' &&
      ELEVEN_LANGUAGES.some((language) => language.code === saved.dialogueSettings!.languageCode.toLowerCase())
        ? saved.dialogueSettings.languageCode.toLowerCase()
        : DEFAULT_DIALOGUE_SETTINGS.languageCode,
  }
}

const DEFAULT_LINES: DialogueLine[] = [
  { id: 'l0', voice: ELEVEN_VOICES[0].id, text: 'So — did the edit come together?' },
  { id: 'l1', voice: ELEVEN_VOICES[1].id, text: '[laughs] Almost. One more shot and it sings.' },
]

export function VoiceOver({ onBack, toast, onSpend }: VoiceOverProps) {
  const saved = useRef(loadVoiceState()).current
  const [phase, setPhase] = useState<Phase>('form')
  const [charged, setCharged] = useState<number | null>(null)
  const [model, setModel] = useState(() =>
    ELEVEN_MODELS.some((m) => m.id === saved.model) ? saved.model! : DEFAULT_TTS_MODEL,
  )
  const [settingsByModel, setSettingsByModel] = useState<Record<string, TtsModelState>>(() => {
    const legacy: Partial<TtsModelState> = {
      voice: saved.voice,
      text: saved.text,
      ...(saved.sliders ?? {}),
    }
    return Object.fromEntries(
      ELEVEN_MODELS.filter((item) => item.kind === 'tts').map((item) => [
        item.id,
        normalizeTtsState(saved.settingsByModel?.[item.id] ?? (saved.model === item.id ? legacy : undefined), item.id),
      ]),
    )
  })

  // Dialogue (Eleven v3) state.
  const validSavedLines =
    saved.lines?.filter((l) => l && ELEVEN_VOICES.some((v) => v.id === l.voice)).map((l) => ({ ...l })) ?? []
  const [lines, setLines] = useState<DialogueLine[]>(validSavedLines.length ? validSavedLines : DEFAULT_LINES)
  const [dialogueSettings, setDialogueSettings] = useState<DialogueSettings>(() => normalizeDialogueSettings(saved))
  const lineIdRef = useRef(100)
  const [activeLineId, setActiveLineId] = useState<string | null>(null)

  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const generation = useGenerationJobControl()
  useEffect(() => {
    saveValue(
      PREFS_KEY,
      JSON.stringify({ model, settingsByModel, lines, dialogueSettings } satisfies VoicePrefs),
    )
  }, [model, settingsByModel, lines, dialogueSettings])

  const kind = modelKind(model)
  const ttsState = settingsByModel[model] ?? normalizeTtsState(undefined, model)
  const { voice, text, timestamps, previousText, nextText } = ttsState
  const sliders = ttsState as unknown as Record<string, number>
  const setTtsState = (patch: Partial<TtsModelState>) =>
    setSettingsByModel((previous) => ({
      ...previous,
      [model]: { ...(previous[model] ?? normalizeTtsState(undefined, model)), ...patch },
    }))
  const setSlider = (key: string, value: number) => setTtsState({ [key]: value } as Partial<TtsModelState>)

  // Dialogue line handlers
  const addLine = () => {
    if (lines.length >= MAX_LINES) return
    const nextVoice = ELEVEN_VOICES[lines.length % ELEVEN_VOICES.length].id
    setLines((prev) => [...prev, { id: `l${lineIdRef.current++}`, voice: nextVoice, text: '' }])
  }
  const removeLine = (id: string) => setLines((prev) => (prev.length <= 1 ? prev : prev.filter((l) => l.id !== id)))
  const setLineVoice = (id: string, voiceId: string) =>
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, voice: voiceId } : l)))
  const setLineText = (id: string, value: string) =>
    setLines((previous) => {
      const otherCharacters = previous.reduce((sum, line) => sum + (line.id === id ? 0 : line.text.length), 0)
      const maximum = Math.max(0, Math.min(LINE_MAX, DIALOGUE_TEXT_MAX - otherCharacters))
      return previous.map((line) => (line.id === id ? { ...line, text: value.slice(0, maximum) } : line))
    })
  const insertTag = (tag: string) => {
    const id = activeLineId ?? lines[lines.length - 1]?.id
    if (!id) return
    setLines((previous) => {
      const otherCharacters = previous.reduce((sum, line) => sum + (line.id === id ? 0 : line.text.length), 0)
      const maximum = Math.max(0, Math.min(LINE_MAX, DIALOGUE_TEXT_MAX - otherCharacters))
      return previous.map((line) =>
        line.id === id
          ? { ...line, text: `${line.text}${line.text ? ' ' : ''}${tag}`.slice(0, maximum) }
          : line,
      )
    })
  }

  const auditionVoice = async (voiceId: string, options: VoiceAuditionRunOptions): Promise<string> => {
    const auditionModel = kind === 'tts' ? model : 'turbo-2-5'
    const auditionSettings = settingsByModel[auditionModel] ?? normalizeTtsState(undefined, auditionModel)
    const result = await runTts(auditionModel, voiceId, AUDITION_TEXT, auditionSettings, {
      autoOpenJob: false,
      signal: options.signal,
      onJobCreated: options.onJobCreated,
    })
    if (!result.urls.length) throw new Error('No voice preview was returned. Please try again.')
    const auditionCharge = result.credits ?? resolveCharged(ttsRunEstimate(auditionModel, AUDITION_TEXT.length))
    onSpend(auditionCharge ?? 0)
    return result.urls[0]
  }

  const dialogueChars = lines.reduce((n, l) => n + l.text.length, 0)
  const chars = kind === 'dialogue' ? dialogueChars : text.length

  const generate = async () => {
    setError(null)
    setPhase('generating')
    const controller = generation.begin()
    try {
      const res =
        kind === 'dialogue'
          ? await runDialogue(lines.map((l) => ({ voice: l.voice, text: l.text })), dialogueSettings, { signal: controller.signal, onJobCreated: generation.attachJob })
          : await runTts(model, voice, text, ttsState, { signal: controller.signal, onJobCreated: generation.attachJob })
      if (controller.signal.aborted) return
      if (!res.urls.length) {
        setError('No audio was returned — please try again.')
        setPhase('form')
        return
      }
      const c = res.credits ?? resolveCharged(ttsRunEstimate(model, chars))
      setCharged(c)
      onSpend(c ?? 0)
      setResultUrl(res.urls[0])
      addCreation({ kind: 'audio', url: res.urls[0], model: modelLabel(model), prompt: kind === 'dialogue' ? `${lines.length} speakers` : text.slice(0, 80), meta: kind === 'dialogue' ? 'dialogue' : voiceLabel(voice) })
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
      ? 'Voice generation continues in Activity · the audio will be saved to Library'
      : 'Voice generation cancelled')
  }

  const modelOptions = ELEVEN_MODELS.map((m) => m.label)
  const connected = isConnected()
  const estimate = ttsRunEstimate(model, chars)
  const auditionModel = kind === 'tts' ? model : 'turbo-2-5'
  const auditionPriceLabel = formatEstimate(ttsRunEstimate(auditionModel, AUDITION_TEXT.length))
  const spendApproval = getSpendApproval(estimate, loadSettings().spendLimit)
  const spendBlocked = connected && !spendApproval.approved
  const hasText = kind === 'dialogue' ? lines.some((line) => line.text.trim()) : Boolean(text.trim())
  const inputInvalid = !hasText || chars > TEXT_MAX
  const turboLanguageOptions = TURBO_LANGUAGES.map((language) => language.label)
  const dialogueLanguageOptions = ELEVEN_LANGUAGES.map((language) => language.label)

  return (
    <div className="ef-screen ef-legacy-workspace ef-voice-over-screen">
      <div className="ef-sub-header">
        <button type="button" className="ef-back" onClick={onBack} aria-label="Back to tools">‹</button>
        <span className="ef-sub-title">Voice Over</span>
        <span className="ef-spacer" />
        <span className="ef-model-badge">ELEVENLABS</span>
      </div>

      <div className="ef-scroll ef-create-scroll">
        {phase === 'form' && (
          <div className="ef-audio-monitor-empty" role="status">
            <span className="ef-audio-monitor-label">VOICE MONITOR · 48 KHZ</span>
            <div className="ef-audio-monitor-wave" aria-hidden="true">{Array.from({ length: 34 }, (_, index) => <i key={index} style={{ height: `${16 + ((index * 23) % 70)}%` }} />)}</div>
            <strong>Line-based voice preview</strong>
            <small>Regenerate individual lines and review timing before timeline placement.</small>
          </div>
        )}
        <div className="ef-field">
          <span className="ef-field-label">MODEL</span>
          <Dropdown
            options={modelOptions}
            selected={modelLabel(model)}
            onSelect={(label) => setModel(ELEVEN_MODELS.find((m) => m.label === label)?.id ?? model)}
            label="Voice model"
            align="left"
            variant="field"
            optionMeta={VOICE_MODEL_META}
            searchable={false}
          />
        </div>

        {kind === 'tts' ? (
          <>
            <VoicePicker voices={ELEVEN_VOICES} value={voice} onChange={(value) => setTtsState({ voice: value })} onAudition={auditionVoice} auditionPriceLabel={auditionPriceLabel} />

            <div className="ef-field">
              <div className="ef-ref-header">
                <span className="ef-field-label">SCRIPT</span>
                <span className="ef-spacer" />
                <span className="ef-ref-count">{text.length} / {TEXT_MAX}</span>
              </div>
              <textarea
                className="ef-text-input"
                rows={4}
                placeholder="Type the narration…"
                value={text}
                maxLength={TEXT_MAX}
                onChange={(e) => setTtsState({ text: e.target.value })}
              />
            </div>

            {model === 'turbo-2-5' && (
              <div className="ef-field">
                <span className="ef-field-label">LANGUAGE</span>
                <Dropdown
                  options={turboLanguageOptions}
                  selected={languageLabel(ttsState.languageCode)}
                  onSelect={(label) => setTtsState({ languageCode: languageCode(label) })}
                  label="Turbo language"
                  align="left"
                  variant="field"
                  searchable
                />
                <span className="ef-dialogue-hint">Turbo v2.5 only · ISO 639-1. Auto detect sends no language code.</span>
              </div>
            )}

            {TTS_SLIDERS.map((s) => (
              <div className="ef-field" key={s.key}>
                <div className="ef-ref-header">
                  <span className="ef-field-label">{s.label}</span>
                  <span className="ef-spacer" />
                  <span className="ef-ref-count">{sliders[s.key].toFixed(2)}</span>
                </div>
                <input
                  className="ef-brush-slider"
                  type="range"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={sliders[s.key]}
                  onChange={(e) => setSlider(s.key, Number(e.target.value))}
                  aria-label={s.label}
                />
              </div>
            ))}

            <div className="ef-field ef-voice-context">
              <div className="ef-ref-header">
                <span className="ef-field-label">DELIVERY CONTEXT</span>
                <span className="ef-spacer" />
                <span className="ef-dialogue-hint">Improves continuity across generated segments</span>
              </div>
              <label className="ef-voice-context-field">
                <span>Previous text</span>
                <span className="ef-ref-count">{previousText.length} / {CONTEXT_MAX}</span>
                <textarea
                  className="ef-text-input"
                  rows={2}
                  value={previousText}
                  maxLength={CONTEXT_MAX}
                  placeholder="Text immediately before this segment…"
                  onChange={(event) => setTtsState({ previousText: event.target.value })}
                />
              </label>
              <label className="ef-voice-context-field">
                <span>Next text</span>
                <span className="ef-ref-count">{nextText.length} / {CONTEXT_MAX}</span>
                <textarea
                  className="ef-text-input"
                  rows={2}
                  value={nextText}
                  maxLength={CONTEXT_MAX}
                  placeholder="Text immediately after this segment…"
                  onChange={(event) => setTtsState({ nextText: event.target.value })}
                />
              </label>
            </div>

            <div className="ef-field ef-voice-toggle-row">
              <span>
                <strong>WORD TIMESTAMPS</strong>
                <small>Request timing metadata for each generated word.</small>
              </span>
              <button
                type="button"
                role="switch"
                aria-label="Return word timestamps"
                aria-checked={timestamps}
                className={'ef-voice-switch' + (timestamps ? ' is-on' : '')}
                onClick={() => setTtsState({ timestamps: !timestamps })}
              >
                <span />
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="ef-field">
              <div className="ef-ref-header">
                <span className="ef-field-label">DIALOGUE</span>
                <span className="ef-spacer" />
                <span className="ef-ref-count">{lines.length} / {MAX_LINES} lines · {dialogueChars} / {DIALOGUE_TEXT_MAX} chars</span>
              </div>
              <div className="ef-dialogue-lines">
                {lines.map((line) => (
                  <div className="ef-dialogue-line" key={line.id}>
                    <div className="ef-dialogue-line-head">
                      <VoicePicker voices={ELEVEN_VOICES} value={line.voice} onChange={(voiceId) => setLineVoice(line.id, voiceId)} label="Speaker" onAudition={auditionVoice} auditionPriceLabel={auditionPriceLabel} />
                      <button
                        className="ef-dialogue-remove"
                        aria-label="Remove line"
                        disabled={lines.length <= 1}
                        onClick={() => removeLine(line.id)}
                      >
                        ✕
                      </button>
                    </div>
                    <input
                      className="ef-text-input"
                      placeholder="What they say…"
                      value={line.text}
                      maxLength={Math.min(
                        LINE_MAX,
                        line.text.length + Math.max(0, DIALOGUE_TEXT_MAX - dialogueChars),
                      )}
                      onFocus={() => setActiveLineId(line.id)}
                      onChange={(e) => setLineText(line.id, e.target.value)}
                    />
                  </div>
                ))}
              </div>
              {lines.length < MAX_LINES && (
                <button className="ef-dialogue-add" onClick={addLine}>
                  <Icon glyph="up" size={12} /> Add line
                </button>
              )}
            </div>

            <div className="ef-field">
              <span className="ef-field-label">AUDIO TAGS</span>
              <div className="ef-audio-tags">
                {AUDIO_TAGS.map((tag) => (
                  <button key={tag} className="ef-tag-chip" onClick={() => insertTag(tag)}>
                    {tag}
                  </button>
                ))}
              </div>
              <span className="ef-dialogue-hint">Tap to insert into the selected line, or type tags inline.</span>
            </div>

            <div className="ef-field">
              <span className="ef-field-label">LANGUAGE</span>
              <Dropdown
                options={dialogueLanguageOptions}
                selected={languageLabel(dialogueSettings.languageCode)}
                onSelect={(label) => setDialogueSettings((previous) => ({ ...previous, languageCode: languageCode(label) }))}
                label="Dialogue language"
                align="left"
                variant="field"
                searchable
              />
              <span className="ef-dialogue-hint">Choose Hebrew (he) or another supported language, or keep automatic detection.</span>
            </div>

            <div className="ef-field">
              <div className="ef-ref-header">
                <span className="ef-field-label">STABILITY</span>
                <span className="ef-spacer" />
                <span className="ef-ref-count">{dialogueSettings.stability.toFixed(1)}</span>
              </div>
              <div className="ef-dialogue-stability" role="group" aria-label="Dialogue stability">
                {DIALOGUE_STABILITY_VALUES.map((value) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={dialogueSettings.stability === value}
                    className={dialogueSettings.stability === value ? 'is-selected' : ''}
                    onClick={() => setDialogueSettings((previous) => ({ ...previous, stability: value }))}
                  >
                    {value.toFixed(1)}
                  </button>
                ))}
              </div>
              <span className="ef-dialogue-hint">Eleven v3 accepts exactly 0.0, 0.5, or 1.0.</span>
            </div>
          </>
        )}

        {phase === 'generating' && (
          <>
            <div className="ef-gen-block" role="status" aria-live="polite" aria-atomic="true" aria-label={kind === 'dialogue' ? 'Performing dialogue' : 'Generating voice over'}>
              <div className="ef-audio-wave" aria-hidden="true">
                {Array.from({ length: 28 }, (_, i) => (
                  <span key={i} style={{ animationDelay: `${i * 0.05}s` }} />
                ))}
              </div>
              <span className="ef-gen-caption">{kind === 'dialogue' ? 'PERFORMING…' : 'SPEAKING…'}</span>
            </div>
            <GenerationCancelControl job={generation.job} onExit={exitGeneration} noun={kind === 'dialogue' ? 'dialogue' : 'voice generation'} />
          </>
        )}

        {phase === 'done' && resultUrl && (
          <div className="ef-done-block" role="region" aria-label="Generated voice result">
            <div className="ef-audio-meta" style={{ marginBottom: 8 }}>
              <span className="ef-audio-name">
                {kind === 'dialogue' ? `${modelLabel(model)} · ${lines.length} speakers` : `${voiceLabel(voice)} · ${modelLabel(model)}`}
              </span>
            </div>
            <audio
              className="ef-audio-player"
              src={resultUrl}
              controls
              aria-label={kind === 'dialogue' ? 'Preview generated dialogue' : `Preview generated voice over by ${voiceLabel(voice)}`}
              style={{ width: '100%' }}
            />
            <div className="ef-charged">{formatCharged(charged)}</div>
            <div className="ef-result-actions">
              <button type="button" className="ef-ghost-btn" onClick={() => setPhase('form')}>↺ Create another</button>
              <a className="ef-ghost-btn" href={resultUrl} download="easyfield-voice.mp3" style={{ textAlign: 'center', textDecoration: 'none', lineHeight: '2.4' }}>↓ Download</a>
              <button
                type="button"
                className="ef-send-btn"
                onClick={() =>
                  sendToTimeline(
                    [{ url: resultUrl, name: kind === 'dialogue' ? `${modelLabel(model)} dialogue` : `${voiceLabel(voice)} · ${modelLabel(model)}` }],
                    'audio',
                    toast,
                  )
                }
              >
                Send to timeline
              </button>
            </div>
          </div>
        )}
      </div>

      {phase === 'form' && (
        <footer className="ef-create-footer" aria-label="Voice generation summary">
          <PriceEstimate estimate={estimate} />
          <div className={`ef-create-footer-message ${error || spendBlocked || inputInvalid ? 'is-error' : connected ? 'is-ready' : 'is-help'}`} role={error || spendBlocked || inputInvalid ? 'alert' : 'status'} aria-live="polite">
            {error
              ? `✕ ${error}`
              : !connected
                ? 'Connect Kie.ai to generate voice'
                : inputInvalid
                  ? `✕ ${kind === 'dialogue' ? 'Add dialogue text (5,000 characters maximum)' : 'Add narration text (5,000 characters maximum)'}`
                : spendBlocked
                  ? `✕ ${spendApproval.reason}`
                  : `${kind === 'dialogue' ? `${lines.length} dialogue lines` : `${chars} characters`} · original timing preserved`}
          </div>
          <button type="button" className="ef-generate ef-create-footer-action" onClick={generate} disabled={!connected || !spendApproval.approved || inputInvalid}>
            <Icon glyph="spark" color="#0E0E13" size={13} /> {kind === 'dialogue' ? 'Perform dialogue' : 'Generate voice'}
          </button>
        </footer>
      )}
    </div>
  )
}
