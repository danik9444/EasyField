// Chat models via EasyField Cloud turn a rough idea into a director-grade,
// model-tailored generation prompt. The gateway supports several native protocols,
// there are three protocols (all verified live 2026-07-08):
//   Anthropic (Claude)  POST /claude/v1/messages            → content[].text
//   OpenAI chat (Gemini) POST /{slug}/v1/chat/completions   → choices[0].message.content
//   Responses (GPT/Grok)   POST /codex|grok/v1/responses    → output[].content[].text
// Cost isn't returned by the chat endpoints, so we measure the exact spend from
// the live credit-balance delta around the call.
import { currentApiKey } from '../settings.ts'
import { fetchCredits, neutralizeProviderMessage } from './providerGateway.ts'
import type { PlacementMode, ToolId } from '../core/contracts.ts'
import { CHAT_MODELS } from '../data/chatModels.ts'
import type { StoryboardTimingMode } from '../data/storyboard.ts'
import { sampleVideoFrames } from './videoContext.ts'
import {
  DEFAULT_BRAIN_MODE,
  brainModePlannerInstruction,
  brainQuestionLimitForTurn,
  type BrainModeId,
} from '../data/superBrainModes.ts'
import { promptCharacterCount, truncatePrompt } from '../data/promptLimits.ts'

// Always relative: the serving origin provides the provider proxy — the Vite dev
// server in development, the plugin's embedded server inside DaVinci Resolve in
// production. (A standalone static web build would need to supply its own.)
const ROOT = '/provider'

export class ChatError extends Error {
  credits: number | null = null

  constructor(message: string) {
    super(neutralizeProviderMessage(message))
    this.name = 'ChatError'
  }
}

// An attachment the enhancer should factor in. Image refs are shown directly.
// Local video refs are decoded into ordered, timestamped visual frames so every
// verified multimodal chat model receives real picture context without sending
// a huge source clip through an undocumented provider field.
export interface EnhanceReference {
  role: string // 'reference image' | 'first frame' | 'video reference' | 'audio reference' | …
  label?: string // the file/clip name — the "tag" the user attached
  imageUrl?: string // a browser URL (blob:/data:/http) of an IMAGE to actually show the model
  videoUrl?: string // browser URL of a VIDEO sampled into ordered visual frames
  durationSeconds?: number
  note?: string // extra text context for non-visual refs (e.g. a timeline timecode)
}

export interface EnhanceSupportingContext {
  label: string
  text: string
  /** Trusted product instruction describing how this read-only context should influence the primary text. */
  instruction?: string
}

// The largest verified image-model quota in the UI is 16 (GPT Image 2).
// Keep prompt enhancement and Storyboard planning aligned with that quota so
// references accepted by the workspace are not silently omitted from chat.
export const MAX_CHAT_REFERENCE_ATTACHMENTS = 16

export function limitChatReferences(references: readonly EnhanceReference[] = []): EnhanceReference[] {
  return references.slice(0, MAX_CHAT_REFERENCE_ATTACHMENTS)
}

interface InlineImage {
  mediaType: string
  dataB64: string
}

// Load a browser-reachable image URL into an <img>. Used only client-side.
function loadImageEl(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image()
    im.onload = () => res(im)
    im.onerror = () => rej(new Error('image load failed'))
    im.src = url
  })
}

// Downscale a reference image to a vision-friendly JPEG (kept small so payloads
// stay light and fast). Returns null on any failure (tainted canvas, load error)
// so the ref degrades to a text mention rather than breaking the enhancement.
async function toInlineImage(url: string, maxDim = 1024): Promise<InlineImage | null> {
  try {
    const im = await loadImageEl(url)
    const w0 = im.naturalWidth || im.width
    const h0 = im.naturalHeight || im.height
    if (!w0 || !h0) return null
    const scale = Math.min(1, maxDim / Math.max(w0, h0))
    const w = Math.max(1, Math.round(w0 * scale))
    const h = Math.max(1, Math.round(h0 * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(im, 0, 0, w, h)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
    const comma = dataUrl.indexOf(',')
    if (comma < 0) return null
    return { mediaType: 'image/jpeg', dataB64: dataUrl.slice(comma + 1) }
  } catch {
    return null
  }
}

// Models write cleaner when reminded to emit ONLY the prompt, but occasionally
// still wrap it — strip quotes / a leading label just in case.
function cleanPrompt(s: string): string {
  let t = s.trim()
  t = t.replace(/^["'`“”]+|["'`“”]+$/g, '').trim()
  t = t.replace(/^(enhanced prompt|final prompt|prompt|here'?s the prompt)\s*[:\-—]\s*/i, '').trim()
  return t
}

const bearer = (key: string) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' })

async function anthropic(key: string, model: string, system: string, user: string, images: InlineImage[], signal?: AbortSignal): Promise<string> {
  const content = images.length
    ? [
        ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.dataB64 } })),
        { type: 'text', text: user },
      ]
    : user
  const r = await fetch(`${ROOT}/claude/v1/messages`, {
    method: 'POST',
    headers: { ...bearer(key), 'anthropic-version': '2023-06-01' },
    signal,
    // The Anthropic-compatible route requires max_tokens in the request.
    // This is a protocol bound, not a spend ceiling; use a generous value and
    // let the provider/model enforce its own actual context/output limits.
    body: JSON.stringify({ model, max_tokens: 16384, temperature: 1, system, messages: [{ role: 'user', content }] }),
  })
  const j = (await r.json().catch(() => null)) as { content?: Array<{ type?: string; text?: string }>; error?: { message?: string }; msg?: string } | null
  const text = Array.isArray(j?.content) ? j!.content!.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('') : ''
  if (!r.ok || !text) throw new ChatError(j?.error?.message || j?.msg || `Enhance failed (${r.status})`)
  return text
}

async function openaiChat(key: string, path: string, model: string, system: string, user: string, images: InlineImage[], signal?: AbortSignal): Promise<string> {
  const userContent = images.length
    ? [
        { type: 'text', text: user },
        ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.dataB64}` } })),
      ]
    : user
  const r = await fetch(`${ROOT}/${path}/v1/chat/completions`, {
    method: 'POST',
    headers: bearer(key),
    signal,
    body: JSON.stringify({ model, temperature: 0.9, messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }] }),
  })
  const j = (await r.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string }; msg?: string } | null
  const text = j?.choices?.[0]?.message?.content
  if (!r.ok || !text) throw new ChatError(j?.error?.message || j?.msg || `Enhance failed (${r.status})`)
  return text
}

async function responses(
  key: string,
  path: string,
  model: string,
  system: string,
  user: string,
  images: InlineImage[],
  effort: 'low' | 'medium' | 'high' | 'xhigh',
  signal?: AbortSignal,
): Promise<string> {
  // GPT 5.6 and Grok Responses publish `model`, `input`, `stream`, `reasoning`
  // and optional tools — not the older `instructions` field. Keep the system
  // contract inside the input text so the payload matches both exact schemas.
  const directedInput = `${system}\n\nUSER REQUEST:\n${user}`
  const input = images.length
    ? [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: directedInput },
            ...images.map((img) => ({ type: 'input_image', image_url: `data:${img.mediaType};base64,${img.dataB64}` })),
          ],
        },
      ]
    : directedInput
  const r = await fetch(`${ROOT}/${path}/v1/responses`, {
    method: 'POST',
    headers: bearer(key),
    signal,
    body: JSON.stringify({ model, input, reasoning: { effort }, stream: false }),
  })
  const j = (await r.json().catch(() => null)) as
    | { output_text?: string; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>; error?: { message?: string }; msg?: string }
    | null
  let text = typeof j?.output_text === 'string' ? j.output_text : ''
  if (!text && Array.isArray(j?.output)) {
    text = j!
      .output!.filter((o) => o.type === 'message')
      .flatMap((o) => (o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text ?? ''))
      .join('')
  }
  if (!r.ok || !text) throw new ChatError(j?.error?.message || j?.msg || `Enhance failed (${r.status})`)
  return text
}

async function chatComplete(key: string, appModel: string, system: string, user: string, images: InlineImage[], signal?: AbortSignal): Promise<string> {
  const m = CHAT_MODELS[appModel] ?? CHAT_MODELS['Opus 4.8']
  const raw =
    m.family === 'anthropic'
      ? await anthropic(key, m.model, system, user, images, signal)
      : m.family === 'openai'
        ? await openaiChat(key, m.path ?? m.model, m.model, system, user, images, signal)
        : await responses(key, m.path ?? 'codex', m.model, system, user, images, m.reasoningEffort ?? 'medium', signal)
  return cleanPrompt(raw)
}

export type EnhanceMediaKind = 'image' | 'video' | 'audio' | 'workflow'

export interface EnhanceUserMessageInput {
  rough: string
  targetModel: string
  mediaKind: EnhanceMediaKind
  style?: string
  supportingContext?: EnhanceSupportingContext
}

export function buildEnhanceUserMessage(
  input: EnhanceUserMessageInput,
  referenceManifest: readonly string[] = [],
  attachedImageCount = 0,
): string {
  const styleNote = input.style && input.style.toLowerCase() !== 'none' ? ` in a ${input.style} style` : ''
  let user = `PRIMARY TEXT TO IMPROVE for a ${input.mediaKind}${styleNote} (for the ${input.targetModel} model):\n"${input.rough.trim()}"`
  if (input.supportingContext?.text.trim()) {
    user += `\n\nREAD-ONLY ${input.supportingContext.label.toUpperCase()}:\n${input.supportingContext.text.trim()}`
  }
  if (referenceManifest.length) {
    user += `\n\nReference material I attached to guide the look:\n${referenceManifest.join('\n')}`
    if (attachedImageCount) user += `\n\n${attachedImageCount} visual reference frame(s) are attached below, in the same order described above. Ordered video frames are chronological; use their timestamp notes to understand how the action develops.`
  }
  return user
}

// The enhancer works across every EasyField workspace. Visual generation keeps
// its director language, audio gets production language, and analysis/editing
// tools get a precise non-destructive workflow brief.
function buildSystem(
  targetModel: string,
  mediaKind: EnhanceMediaKind,
  maxLength: number,
  style?: string,
  hasReferences?: boolean,
  supportingContext?: EnhanceSupportingContext,
): string {
  const video = mediaKind === 'video'
  const image = mediaKind === 'image'
  const audio = mediaKind === 'audio'
  const workflow = mediaKind === 'workflow'
  const styled = style && style.toLowerCase() !== 'none'
  const taskLabel = workflow ? 'editing or analysis workflow' : `${mediaKind}-generation task`
  const role = audio ? 'audio director and prompt writer' : workflow ? 'senior film editor and workflow designer' : `creative ${video ? 'director and ' : ''}prompt writer`
  const craftGuidance = audio
    ? 'Cover, as relevant: the exact sound source or musical idea; performance and emotion; tempo, rhythm and timing; instrumentation or Foley events; texture, dynamics, spatial perspective, ambience, transitions, mix priorities and a clear ending.'
    : workflow
      ? 'Cover, as relevant: the editorial objective; source scope; selection or analysis criteria; timing and ordering; what must be preserved; the expected output; review checkpoints; and any safety constraints. Never invent a destructive operation.'
      : `Cover, as relevant: the subject and its appearance; composition and framing; ${video ? 'camera movement, lens choice, subject motion, pacing, and how the shot evolves across its duration; ' : 'lens/optics, focal length and depth of field; '}lighting (source, direction, quality, colour temperature); colour palette and grade; environment and background; mood and atmosphere; textures and materials; and rendering/quality cues.`
  const modelGuidance = video
    ? 'as a video model — favour clear, describable motion and temporal beats'
    : image
      ? 'as an image model — favour concrete visual detail and precise composition; avoid camera-motion or temporal language'
      : audio
        ? 'as an audio model — use audible, producible detail and explicit timing instead of visual-only adjectives'
        : 'for this editing workflow — make every instruction reviewable, scoped and non-destructive'
  return [
    `You are a helpful ${role} inside a professional post-production app. The user gives a rough idea or note; expand it into one precise, useful brief for the ${taskLabel}, tailored to "${targetModel}". Reply with just the finished brief.`,
    ``,
    `LANGUAGE: Write the prompt in English. If the idea is in Hebrew or another language, understand it and express it as natural English.`,
    styled
      ? `\nSTYLE: The user chose a "${style}" style — let it guide the whole aesthetic (visual treatment, composition, lighting, colour, texture, rendering), not just a tacked-on label.`
      : null,
    hasReferences
      ? `\nREFERENCES: The user attached reference material (listed, with visual frames shown, in their message). Use attached stills and timestamped video frames as real visual evidence. Video frames are ordered chronologically: infer only actions and timing visibly supported by them, preserve the user's written intent, and never claim that the downstream generation model receives the source video directly.`
      : null,
    supportingContext?.text.trim()
      ? `\nSUPPORTING CONTEXT: The user message includes a read-only “${supportingContext.label}” section. Use it to keep the primary text consistent, but improve only the primary text and never rewrite, quote, summarize or output the supporting fields. ${supportingContext.instruction ?? 'Do not invent facts that contradict the supporting context.'}`
      : null,
    ``,
    `Write with rich, production-ready specificity. ${craftGuidance}`,
    ``,
    `Tailor the wording to how "${targetModel}" performs best ${modelGuidance}.`,
    ``,
    `Guidelines:`,
    `- Reply with only the final prompt text — no preamble, explanation, lists, quotes, markdown, or labels.`,
    `- One flowing, coherent, richly detailed description an artist could execute for a precise result.`,
    `- Keep the user's core intent and every specific detail they gave; enrich, don't contradict.`,
    `- Stay under ${maxLength} characters.`,
  ]
    .filter((l) => l !== null)
    .join('\n')
}

export interface EnhanceResult {
  text: string
  credits: number | null // exact cost from the live balance delta (null if unknown)
}

async function prepareVisualReferences(references: EnhanceReference[] = [], signal?: AbortSignal): Promise<{
  images: InlineImage[]
  manifest: string[]
}> {
  const refs = limitChatReferences(references)
  const images: InlineImage[] = []
  const manifest: string[] = []
  for (const ref of refs) {
    let shown = 0
    if (ref.imageUrl && images.length < MAX_CHAT_REFERENCE_ATTACHMENTS) {
      const image = await toInlineImage(ref.imageUrl)
      if (image) {
        images.push(image)
        shown = 1
      }
    }
    let sampledTimes: number[] = []
    if (ref.videoUrl && images.length < MAX_CHAT_REFERENCE_ATTACHMENTS) {
      const frames = await sampleVideoFrames(ref.videoUrl, {
        durationSeconds: ref.durationSeconds,
        maximumFrames: Math.min(8, MAX_CHAT_REFERENCE_ATTACHMENTS - images.length),
        signal,
      })
      for (const frame of frames) {
        images.push({ mediaType: frame.mediaType, dataB64: frame.dataB64 })
        sampledTimes.push(frame.timeSeconds)
        shown += 1
      }
    }
    const label = ref.label ? ` "${ref.label}"` : ''
    const duration = ref.durationSeconds && Number.isFinite(ref.durationSeconds)
      ? ` · duration ${ref.durationSeconds.toFixed(ref.durationSeconds < 10 ? 2 : 1)}s`
      : ''
    const note = ref.note ? ` — ${ref.note}` : ''
    const visualNote = sampledTimes.length
      ? ` [${sampledTimes.length} ordered video frames attached at ${sampledTimes.map((time) => `${time.toFixed(2)}s`).join(', ')}]`
      : shown
        ? ' [image attached]'
        : ref.videoUrl
          ? ' [video could not be sampled; use label and duration only]'
          : ''
    manifest.push(`- ${ref.role}${label}${duration}${note}${visualNote}`)
  }
  return { images, manifest }
}

export async function enhancePrompt(opts: {
  rough: string
  targetModel: string
  mediaKind: EnhanceMediaKind
  chatModel: string
  maxLength: number
  style?: string
  references?: EnhanceReference[]
  supportingContext?: EnhanceSupportingContext
  signal?: AbortSignal
}): Promise<EnhanceResult> {
  const key = currentApiKey()
  if (!key) throw new ChatError('Connect your EasyField Cloud API key first (tap the credits badge on Home).')

  // Resolve attachments: fetch+downscale image refs into inline vision images,
  // and describe every ref (image/video/audio) by role + label in a manifest.
  const { images, manifest } = await prepareVisualReferences(opts.references, opts.signal)

  const before = await fetchCredits(key)
  const system = buildSystem(
    opts.targetModel,
    opts.mediaKind,
    opts.maxLength,
    opts.style,
    manifest.length > 0,
    opts.supportingContext,
  )
  const user = buildEnhanceUserMessage(opts, manifest, images.length)
  let text = await chatComplete(key, opts.chatModel, system, user, images, opts.signal)
  // A safety net: if the model returned a refusal/apology instead of a prompt,
  // surface it as an error rather than pasting non-prompt text into the box.
  if (/^\s*(i (can'?t|cannot|can not|won'?t|am unable|'?m unable|am not able|'?m not able)|i'?m sorry|sorry[,.]|as an ai|unfortunately,? i)/i.test(text)) {
    throw new ChatError('The enhancer declined this request — try rephrasing your idea or removing a reference.')
  }
  if (promptCharacterCount(text) > opts.maxLength) text = truncatePrompt(text, opts.maxLength).trim()
  const after = await fetchCredits(key)
  const credits = before.ok && after.ok && before.credits != null && after.credits != null ? Math.max(0, before.credits - after.credits) : null
  return { text, credits }
}

export interface StoryboardPlanScene {
  title: string
  prompt: string
  explanation: string
  durationSeconds?: number
}

export interface StoryboardPlanResult {
  summary: string
  scenes: StoryboardPlanScene[]
  totalDurationSeconds?: number
  chatCredits: number | null
}

function sanitizeStoryboardPlanText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new ChatError(`Storyboard returned an invalid ${field}. Try again.`)
  const text = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
  const bounded = truncatePrompt(text, maxLength)
  const sanitized = bounded
    .trim()
  if (!sanitized) throw new ChatError(`Storyboard returned an empty ${field}. Try again.`)
  return sanitized
}

export function validateStoryboardPlan(
  raw: unknown,
  timingMode: StoryboardTimingMode,
  requestedTotalDurationSeconds?: number,
  maximumScenes = 20,
  scenePromptMax = 4_000,
): Omit<StoryboardPlanResult, 'chatCredits'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ChatError('Storyboard returned an invalid plan object. Try again.')
  }
  const value = raw as Record<string, unknown>
  const summary = sanitizeStoryboardPlanText(value.summary, 'summary', 4000)
  if (!Array.isArray(value.scenes) || value.scenes.length === 0) {
    throw new ChatError('Storyboard did not return any scenes. Try again.')
  }

  const scenes = value.scenes.slice(0, Math.max(1, Math.min(20, Math.floor(maximumScenes)))).map((item, index): StoryboardPlanScene => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ChatError(`Storyboard returned an invalid scene ${index + 1}. Try again.`)
    }
    const scene = item as Record<string, unknown>
    const result: StoryboardPlanScene = {
      title: sanitizeStoryboardPlanText(scene.title, `title for scene ${index + 1}`, 160),
      prompt: sanitizeStoryboardPlanText(scene.prompt, `prompt for scene ${index + 1}`, scenePromptMax),
      explanation: sanitizeStoryboardPlanText(scene.explanation, `explanation for scene ${index + 1}`, 1200),
    }
    if (timingMode !== 'none') {
      const durationSeconds = typeof scene.durationSeconds === 'number'
        ? scene.durationSeconds
        : Number(scene.durationSeconds)
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isInteger(durationSeconds)) {
        throw new ChatError(`Storyboard returned an invalid duration for scene ${index + 1}. Try again.`)
      }
      result.durationSeconds = durationSeconds
    }
    return result
  })

  if (scenes.length === 0) throw new ChatError('Storyboard did not return any valid scenes. Try again.')
  if (timingMode === 'none') return { summary, scenes }

  const totalDurationSeconds = scenes.reduce((sum, scene) => sum + (scene.durationSeconds ?? 0), 0)
  if (timingMode === 'manual') {
    if (!Number.isFinite(requestedTotalDurationSeconds) || totalDurationSeconds !== Math.round(requestedTotalDurationSeconds!)) {
      throw new ChatError('Storyboard scene durations did not match the requested total. Try again.')
    }
    return { summary, scenes, totalDurationSeconds }
  }
  if (totalDurationSeconds < 5 || totalDurationSeconds > 1_800) {
    throw new ChatError('Storyboard returned an automatic duration outside the supported 5-second to 30-minute range. Try again.')
  }
  const returnedTotal = typeof value.totalDurationSeconds === 'number'
    ? value.totalDurationSeconds
    : Number(value.totalDurationSeconds)
  if (value.totalDurationSeconds !== undefined && (!Number.isInteger(returnedTotal) || returnedTotal !== totalDurationSeconds)) {
    throw new ChatError('Storyboard returned mismatched automatic timing. Try again.')
  }
  return { summary, scenes, totalDurationSeconds }
}

/**
 * Expands one story brief into an ordered, image-generation-ready storyboard.
 * This call returns a text plan only; attached images are visual context and
 * never trigger an image-generation request.
 */
export async function planStoryboard(opts: {
  storyBrief: string
  targetModel: string
  chatModel: string
  timingMode: StoryboardTimingMode
  totalDurationSeconds?: number
  style?: string
  scenePromptMax?: number
  references?: EnhanceReference[]
  signal?: AbortSignal
}): Promise<StoryboardPlanResult> {
  const key = currentApiKey()
  if (!key) throw new ChatError('Connect your EasyField Cloud API key before planning a storyboard.')
  const storyBrief = opts.storyBrief.trim().slice(0, 12000)
  const targetModel = opts.targetModel.trim().slice(0, 240)
  const requestedDuration = Number.isFinite(opts.totalDurationSeconds)
    ? Math.round(opts.totalDurationSeconds!)
    : 30
  const totalDurationSeconds = Math.min(1_800, Math.max(5, requestedDuration))
  const maximumScenes = opts.timingMode === 'manual' ? Math.min(20, totalDurationSeconds) : 20
  const scenePromptMax = Number.isFinite(opts.scenePromptMax)
    ? Math.max(1, Math.floor(opts.scenePromptMax!))
    : 4_000
  const style = opts.style?.trim().slice(0, 400) ?? ''
  if (!storyBrief) throw new ChatError('Describe the story before planning a storyboard.')
  if (!targetModel) throw new ChatError('Choose an image model before planning a storyboard.')

  const system = [
    'You are a film director and storyboard artist inside EasyField, a professional post-production app.',
    opts.timingMode === 'manual'
      ? `Turn the user's single story brief into one coherent visual story lasting exactly ${totalDurationSeconds} seconds. Decide the appropriate number of ordered scenes yourself, from 1 to ${maximumScenes}.`
      : `Turn the user's single story brief into one coherent visual story and decide the appropriate number of ordered scenes yourself, from 1 to ${maximumScenes}.`,
    'Understand Hebrew and any other input language accurately. Write every image prompt in natural, production-ready English.',
    `Tailor every prompt specifically to the still-image generation model "${targetModel}". Use concrete visual detail, composition, lens and framing, lighting, colour, setting, character continuity, action and mood. Do not use camera-motion or video-only timing language.`,
    'Preserve continuity of characters, wardrobe, props, locations, palette and visual style across scenes while giving each scene a distinct narrative beat.',
    'When reference images are attached, treat their visible identity, wardrobe, design language, locations, palette and composition as authoritative continuity guidance for every relevant scene.',
    'Each explanation must concisely state that scene\'s narrative purpose and how it advances the complete story.',
    opts.timingMode === 'manual'
      ? `Assign a positive whole-number durationSeconds to every scene. The scene durations must sum to exactly ${totalDurationSeconds} seconds and should reflect the narrative pacing rather than defaulting blindly to equal lengths.`
      : opts.timingMode === 'auto'
        ? 'Choose the natural overall runtime from the story, from 5 to 1800 seconds. Assign a positive whole-number durationSeconds to every scene based on its narrative density and pacing. Return totalDurationSeconds equal to the exact sum of all scene durations.'
        : '',
    'Return exactly one strict JSON object and nothing else. Never wrap it in markdown or code fences.',
    opts.timingMode === 'none'
      ? 'Schema: {"summary":string,"scenes":[{"title":string,"prompt":string,"explanation":string}]}.'
      : opts.timingMode === 'auto'
        ? 'Schema: {"summary":string,"totalDurationSeconds":number,"scenes":[{"title":string,"prompt":string,"explanation":string,"durationSeconds":number}]}.'
        : 'Schema: {"summary":string,"scenes":[{"title":string,"prompt":string,"explanation":string,"durationSeconds":number}]}.',
    `The summary must concisely explain the complete story arc. scenes must contain between 1 and ${maximumScenes} items in final story order. Every text field must be a non-empty string.`,
    `Keep every scene prompt at or below ${scenePromptMax.toLocaleString()} characters so it fits the selected image model after EasyField adds its visual-direction context.`,
  ].filter(Boolean).join('\n')
  const styleLine = style && style.toLowerCase() !== 'none'
    ? `\nChosen visual style: ${style}. Apply it consistently across the entire storyboard.`
    : ''
  const { images, manifest } = await prepareVisualReferences(opts.references, opts.signal)
  let user = opts.timingMode === 'manual'
    ? `Create a complete ${totalDurationSeconds}-second storyboard from this story brief:\n${storyBrief}${styleLine}`
    : opts.timingMode === 'auto'
      ? `Create a complete storyboard and choose its pacing automatically from this story brief:\n${storyBrief}${styleLine}`
      : `Create a complete storyboard from this story brief:\n${storyBrief}${styleLine}`
  if (manifest.length) {
    user += `\n\nStory reference material to preserve across the scene plan:\n${manifest.join('\n')}`
    if (images.length) user += `\n\n${images.length} reference image(s) are attached in the same order as this list.`
  }

  const before = await fetchCredits(key)
  try {
    const raw = await chatComplete(key, opts.chatModel, system, user, images, opts.signal)
    let parsed: unknown
    try {
      parsed = parseJsonObject(raw)
    } catch (error) {
      if (error instanceof ChatError) throw new ChatError('Storyboard returned malformed plan JSON. Try again.')
      throw error
    }
    const result = validateStoryboardPlan(parsed, opts.timingMode, opts.timingMode === 'manual' ? totalDurationSeconds : undefined, maximumScenes, scenePromptMax)
    const after = await fetchCredits(key)
    const chatCredits = before.ok && after.ok && before.credits != null && after.credits != null
      ? Math.max(0, before.credits - after.credits)
      : null
    return { ...result, chatCredits }
  } catch (error) {
    if (opts.signal?.aborted) throw error
    const after = await fetchCredits(key)
    const credits = before.ok && after.ok && before.credits != null && after.credits != null
      ? Math.max(0, before.credits - after.credits)
      : null
    if (error instanceof ChatError) {
      error.credits = credits
      throw error
    }
    const wrapped = new ChatError(error instanceof Error ? error.message : 'Storyboard planning failed. Try again.')
    wrapped.credits = credits
    throw wrapped
  }
}

export type FoleyConfidence = 'high' | 'medium' | 'low'

export interface FoleyPlanEvent {
  startSeconds: number
  endSeconds: number
  title: string
  prompt: string
  reason: string
  confidence: FoleyConfidence
}

export interface FoleyPlanResult {
  summary: string
  events: FoleyPlanEvent[]
  chatCredits: number | null
}

function safeFoleyText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new ChatError(`Auto Foley returned an invalid ${label}. Try again.`)
  const text = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
  if (!text) throw new ChatError(`Auto Foley returned an empty ${label}. Try again.`)
  if (text.length > maximum) throw new ChatError(`Auto Foley returned a ${label} longer than ${maximum} characters.`)
  return text
}

export function validateFoleyPlan(raw: unknown, durationSeconds: number, maximumEvents = 24): Omit<FoleyPlanResult, 'chatCredits'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ChatError('Auto Foley returned an invalid plan object. Try again.')
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new ChatError('The source video duration is unavailable.')
  const value = raw as Record<string, unknown>
  const summary = safeFoleyText(value.summary, 'summary', 1000)
  if (!Array.isArray(value.events)) throw new ChatError('Auto Foley returned an invalid event list. Try again.')
  if (value.events.length > maximumEvents) throw new ChatError(`Auto Foley returned more than ${maximumEvents} events. Narrow the direction and try again.`)

  const events = value.events.map((item, index): FoleyPlanEvent => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ChatError(`Auto Foley returned an invalid event ${index + 1}.`)
    const event = item as Record<string, unknown>
    const startSeconds = Number(event.startSeconds)
    const endSeconds = Number(event.endSeconds)
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds) {
      throw new ChatError(`Auto Foley returned an invalid time range for event ${index + 1}.`)
    }
    if (startSeconds >= durationSeconds || endSeconds > durationSeconds + 0.05) {
      throw new ChatError(`Auto Foley placed event ${index + 1} outside the source clip.`)
    }
    const confidence = String(event.confidence ?? '').toLowerCase()
    if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') {
      throw new ChatError(`Auto Foley returned an invalid confidence for event ${index + 1}.`)
    }
    return {
      startSeconds: Math.round(startSeconds * 100) / 100,
      endSeconds: Math.round(Math.min(endSeconds, durationSeconds) * 100) / 100,
      title: safeFoleyText(event.title, `title for event ${index + 1}`, 100),
      prompt: safeFoleyText(event.prompt, `sound prompt for event ${index + 1}`, 500),
      reason: safeFoleyText(event.reason, `reason for event ${index + 1}`, 320),
      confidence,
    }
  })
  events.sort((left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds)
  return { summary, events }
}

/**
 * Builds a reviewable timed Foley plan from real chronological video frames.
 * This call never generates audio. Approved events are submitted separately.
 */
export async function planFoleyEvents(opts: {
  direction: string
  sourceName: string
  sourceVideoUrl: string
  durationSeconds: number
  chatModel: string
  maximumEvents?: number
  signal?: AbortSignal
}): Promise<FoleyPlanResult> {
  const key = currentApiKey()
  if (!key) throw new ChatError('Connect your EasyField Cloud API key before analyzing Foley events.')
  const direction = opts.direction.trim().slice(0, 1200)
  const durationSeconds = Math.round(opts.durationSeconds * 1000) / 1000
  const maximumEvents = Math.max(1, Math.min(32, Math.floor(opts.maximumEvents ?? 24)))
  if (!opts.sourceVideoUrl) throw new ChatError('Add or grab a source video before analyzing Foley events.')
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new ChatError('The source video duration is unavailable.')

  const references: EnhanceReference[] = [{
    role: 'source video for timed Foley analysis',
    label: opts.sourceName.trim().slice(0, 200) || 'Source video',
    videoUrl: opts.sourceVideoUrl,
    durationSeconds,
    note: 'Frames are sampled in chronological order from the exact working clip.',
  }]
  const { images, manifest } = await prepareVisualReferences(references, opts.signal)
  if (!images.length) throw new ChatError('EasyField could not read visual frames from this video. Try a local MP4 or a fresh Resolve Grab.')

  const system = [
    'You are a meticulous Foley editor inside EasyField, a professional DaVinci Resolve companion.',
    `Analyze the attached chronological video frames from a ${durationSeconds.toFixed(2)}-second source clip and propose at most ${maximumEvents} visually supported Foley events.`,
    'Use only actions or contacts that are visible enough to justify a sound. Do not invent dialogue, music, off-screen action or a final timeline mix.',
    'The frame samples are sparse. Treat timestamps as editable estimates, use low confidence when timing or the sound source is uncertain, and never claim frame-perfect detection.',
    'Each prompt is sent later to Suno Sounds as an isolated one-shot request. Write a self-contained English sound prompt with source, material, action, intensity, perspective, environment and a clean ending. Never mention the video or ask Suno to synchronize.',
    'Return exactly one strict JSON object and nothing else.',
    'Schema: {"summary":string,"events":[{"startSeconds":number,"endSeconds":number,"title":string,"prompt":string,"reason":string,"confidence":"high"|"medium"|"low"}]}.',
    `Every event must stay inside 0–${durationSeconds.toFixed(2)} seconds, have endSeconds greater than startSeconds, and prompt must be 500 characters or fewer. Sort events chronologically.`,
  ].join('\n')
  const user = [
    `Source: ${opts.sourceName.trim().slice(0, 200) || 'Source video'}`,
    `Duration: ${durationSeconds.toFixed(2)} seconds`,
    direction ? `Editor direction: ${direction}` : 'Editor direction: Cover the clearly visible production-ready Foley; omit music and dialogue.',
    `Visual evidence:\n${manifest.join('\n')}`,
  ].join('\n')

  const before = await fetchCredits(key)
  try {
    const raw = await chatComplete(key, opts.chatModel, system, user, images, opts.signal)
    const result = validateFoleyPlan(parseJsonObject(raw), durationSeconds, maximumEvents)
    const after = await fetchCredits(key)
    const chatCredits = before.ok && after.ok && before.credits != null && after.credits != null
      ? Math.max(0, before.credits - after.credits)
      : null
    return { ...result, chatCredits }
  } catch (error) {
    if (opts.signal?.aborted) throw error
    const after = await fetchCredits(key)
    const credits = before.ok && after.ok && before.credits != null && after.credits != null
      ? Math.max(0, before.credits - after.credits)
      : null
    if (error instanceof ChatError) {
      error.credits = credits
      throw error
    }
    const wrapped = new ChatError(error instanceof Error ? error.message : 'Auto Foley analysis failed. Try again.')
    wrapped.credits = credits
    throw wrapped
  }
}

export interface BrainPlanQuestion {
  id: string
  question: string
  reason: string
}

export interface BrainPlanStepResult {
  id: string
  toolId: ToolId
  title: string
  purpose: string
  modelPreference: string | null
  source: string
  output: string
  placement: PlacementMode | null
  dependsOn: string[]
  destructive: boolean
  maxCredits: number | null
}

export interface BrainPlanResult {
  summary: string
  questions: BrainPlanQuestion[]
  steps: BrainPlanStepResult[]
  assumptions: string[]
  executionBlockers: string[]
  readyForExecution: boolean
  maxCredits: number | null
  chatCredits?: number | null
}

function parseJsonObject(text: string): unknown {
  const fenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const first = fenced.indexOf('{')
  const last = fenced.lastIndexOf('}')
  if (first < 0 || last <= first) throw new ChatError('SuperBrain returned an invalid plan. Try again.')
  try { return JSON.parse(fenced.slice(first, last + 1)) } catch { throw new ChatError('SuperBrain returned malformed plan JSON. Try again.') }
}

const TOOL_IDS = new Set<ToolId>([
  'culling', 'broll', 'upscale', 'create-image', 'storyboard', 'character', 'avatar', 'edit-image', 'angles', 'create-video', 'edit-video',
  'extend', 'transition', 'animations', 'captions', 'music', 'sfx', 'vo', 'transcribe', 'beat',
])
const PLACEMENTS = new Set<PlacementMode>(['playhead', 'replace', 'append', 'media-pool'])

export function validateBrainPlan(raw: unknown, questionLimit = 12): BrainPlanResult {
  if (!raw || typeof raw !== 'object') throw new ChatError('SuperBrain returned an invalid plan object.')
  const value = raw as Record<string, unknown>
  const summary = typeof value.summary === 'string' ? value.summary.trim() : ''
  if (!summary) throw new ChatError('SuperBrain did not explain the plan.')
  const questions = Array.isArray(value.questions)
    ? value.questions.map((item, index) => {
        const q = item && typeof item === 'object' ? item as Record<string, unknown> : {}
        return {
          id: typeof q.id === 'string' && q.id ? q.id : `question-${index + 1}`,
          question: String(q.question ?? '').trim(),
          reason: String(q.reason ?? '').trim(),
        }
      }).filter((question) => question.question)
    : []
  if (questions.length > questionLimit) {
    throw new ChatError(`SuperBrain returned ${questions.length} questions, above this mode's limit of ${questionLimit}. The plan was blocked instead of dropping decisions.`)
  }
  const steps = Array.isArray(value.steps)
    ? value.steps.slice(0, 24).map((item, index) => {
        const step = item && typeof item === 'object' ? item as Record<string, unknown> : {}
        const toolId = String(step.toolId ?? '') as ToolId
        if (!TOOL_IDS.has(toolId)) throw new ChatError(`SuperBrain proposed an unsupported tool: ${toolId || 'unknown'}`)
        const placementValue = step.placement == null ? null : String(step.placement) as PlacementMode
        if (placementValue && !PLACEMENTS.has(placementValue)) throw new ChatError('SuperBrain proposed an unsafe placement mode.')
        return {
          id: typeof step.id === 'string' && step.id ? step.id : `step-${index + 1}`,
          toolId,
          title: String(step.title ?? toolId).trim(),
          purpose: String(step.purpose ?? '').trim(),
          modelPreference: typeof step.modelPreference === 'string' ? step.modelPreference : null,
          source: String(step.source ?? '').trim(),
          output: String(step.output ?? '').trim(),
          placement: placementValue,
          dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.filter((id): id is string => typeof id === 'string') : [],
          destructive: step.destructive === true,
          maxCredits: typeof step.maxCredits === 'number' && step.maxCredits >= 0 ? step.maxCredits : null,
        }
      })
    : []
  const maxCredits = typeof value.maxCredits === 'number' && value.maxCredits >= 0 ? value.maxCredits : null
  const assumptions = Array.isArray(value.assumptions)
    ? value.assumptions.filter((item): item is string => typeof item === 'string' && !!item.trim()).slice(0, 20).map((item) => item.trim())
    : []
  const executionBlockers = Array.isArray(value.executionBlockers)
    ? value.executionBlockers.filter((item): item is string => typeof item === 'string' && !!item.trim()).slice(0, 20).map((item) => item.trim())
    : []
  const readyForExecution = questions.length === 0 && steps.length > 0 && executionBlockers.length === 0
  return { summary, questions, steps, assumptions, executionBlockers, readyForExecution, maxCredits }
}

export async function planTimelineWorkflow(opts: {
  request: string
  conversation?: string[]
  chatModel: string
  timelineContext: string
  mode?: BrainModeId
  questionsAsked?: number
  signal?: AbortSignal
}): Promise<BrainPlanResult> {
  const key = currentApiKey()
  if (!key) throw new ChatError('Connect your EasyField Cloud API key before asking SuperBrain to plan.')
  const allowedTools = [...TOOL_IDS].join(', ')
  const mode = opts.mode ?? DEFAULT_BRAIN_MODE
  const questionsAsked = Math.max(0, Math.floor(opts.questionsAsked ?? 0))
  const questionLimit = brainQuestionLimitForTurn(mode, questionsAsked)
  const system = [
    'You are EasyField SuperBrain, a cautious planning agent for a professional DaVinci Resolve editor.',
    'Return one JSON object only. Never wrap it in markdown.',
    brainModePlannerInstruction(mode, questionsAsked),
    'Outside capped automatic modes, do not invent missing creative choices, sources, models, placement, duration, language, or spending limits. Ask a question for every missing decision.',
    `Allowed toolId values: ${allowedTools}.`,
    'Schema: {"summary":string,"questions":[{"id":string,"question":string,"reason":string}],"steps":[{"id":string,"toolId":string,"title":string,"purpose":string,"modelPreference":string|null,"source":string,"output":string,"placement":"playhead"|"replace"|"append"|"media-pool"|null,"dependsOn":string[],"destructive":boolean,"maxCredits":number|null}],"assumptions":string[],"executionBlockers":string[],"maxCredits":number|null}.',
    'If questions remain, steps may be a partial preview but must not claim readiness. Never estimate a paid price you do not know; use null.',
    'Put every low-risk assumption in assumptions. Put unresolved rights, privacy, upload, price, destructive-action, placement, unavailable-adapter or other mandatory execution gates in executionBlockers.',
    'Mark Cut, Align, Replace and Grade operations destructive. Default additions are non-ripple managed EasyField tracks, but ask before choosing placement.',
  ].join('\n')
  const historyText = (opts.conversation ?? []).slice(-20).join('\n').slice(-24000)
  const history = historyText ? `\nConversation so far:\n${historyText}` : ''
  const user = `Resolve context: ${opts.timelineContext.slice(0, 2000)}\nCurrent request: ${opts.request.trim().slice(0, 32000)}${history}`
  const before = await fetchCredits(key)
  const raw = await chatComplete(key, opts.chatModel, system, user, [], opts.signal)
  const result = validateBrainPlan(parseJsonObject(raw), questionLimit)
  const after = await fetchCredits(key)
  const chatCredits = before.ok && after.ok && before.credits != null && after.credits != null
    ? Math.max(0, before.credits - after.credits)
    : null
  return { ...result, chatCredits }
}
