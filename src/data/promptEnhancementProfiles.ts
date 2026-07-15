export type PromptEnhancementMediaKind = 'image' | 'video' | 'audio' | 'workflow'

export type PromptEnhancementInputMode = 'rewrite' | 'reference-draft'

export type PromptEnhancementPurpose =
  | 'create'
  | 'edit'
  | 'extend'
  | 'transition'
  | 'angle'
  | 'story-brief'
  | 'story-scene'
  | 'multi-shot-scene'
  | 'character-notes'
  | 'animation'
  | 'music'
  | 'single-sfx'
  | 'foley-direction'
  | 'avatar'
  | 'broll'
  | 'captions'
  | 'transcribe'
  | 'beat'
  | 'culling'
  | 'workflow'

export interface PromptEnhancementProfile {
  id: 'adaptive' | 'seedance-2'
  purpose: PromptEnhancementPurpose
  inputMode: PromptEnhancementInputMode
  purposeGuidance: string
  modelGuidance: string
}

const PURPOSE_GUIDANCE: Record<PromptEnhancementPurpose, string> = {
  create: 'Clarify the requested generation. Use only subjects, actions, setting, style and technical choices that the user selected, wrote, or supplied as evidence.',
  edit: 'Describe only the requested change. Preserve every property of the primary source that the user did not ask to change, including identity, composition, timing, motion, lighting, sound and background.',
  extend: 'Describe only the requested continuation from the supplied source. Preserve continuity and do not introduce a new event, subject, location, camera move or sound unless the user requested it.',
  transition: 'Rewrite only the requested transition from the ordered outgoing-shot end frame to the incoming-shot start frame. The result must describe a bridge between those exact endpoints, never a standalone shot or an edit of only one endpoint. Preserve every transition method, motion or effect the user named; do not replace it with a different automatic choice. Do not invent narrative events, subjects, objects, locations, text, dialogue or sound between the frames.',
  angle: 'Refine only camera position, elevation, lens perspective or framing. The source subject, identity, scene, moment, lighting and style remain unchanged unless the user explicitly asks otherwise.',
  'story-brief': 'Improve only the story brief. Keep its scope and intentional omissions; do not turn it into a production checklist and do not invent scenes, characters, events or an ending.',
  'story-scene': 'Improve only the current scene text. Other scenes are read-only continuity evidence; never copy their actions or fill this scene with missing story details.',
  'multi-shot-scene': 'Improve only the current shot. Keep sibling shots read-only, preserve sequence order and timing, and do not import an action or camera instruction from another shot.',
  'character-notes': 'Clarify only the custom character traits the user wrote. UI selections and samples are binding evidence; every unselected trait and placement stays unspecified.',
  animation: 'Clarify the requested animation or motion graphic without inventing claims, copy, data, branding, assets, transitions or sound direction.',
  music: 'Clarify only the musical idea and attributes the user supplied. Do not add instruments, genre, tempo, structure, vocals, ambience or an ending that was not requested.',
  'single-sfx': 'Describe exactly the requested individual sound. Do not add a room, reverb, ambience, music, extra events or a tail unless requested.',
  'foley-direction': 'Describe only Foley events named by the user or visibly supported by the attached source. Do not add music, instrumentation, ambience, off-screen action or unseen impacts.',
  avatar: 'Clarify only the requested speaking or performance direction. Preserve the supplied person, voice, timing and source scene unless the user explicitly requests a change.',
  broll: 'Clarify only the requested coverage or missing visual beat. Do not invent facts about the project, source story, available Library media or timeline gaps.',
  captions: 'Clarify only caption presentation and emphasis. Preserve spoken wording and timing; do not paraphrase dialogue, invent text or add emphasis that was not requested.',
  transcribe: 'Clarify only transcription instructions such as language, names, vocabulary or output handling. Do not invent spoken content, speakers, language or timestamps.',
  beat: 'Clarify only beat-analysis preferences such as marker density, musical sections or sensitivity. Do not invent tempo, beats or song structure before analysis.',
  culling: 'Clarify only review criteria for Keep, Maybe and Reject. Do not invent shot quality, performance issues or destructive source operations before analysis.',
  workflow: 'Clarify the requested workflow while keeping its scope reviewable and non-destructive. Do not add operations, media, decisions or deliverables the user did not request.',
}

const REFERENCE_DRAFT_GUIDANCE: Record<PromptEnhancementPurpose, string> = {
  create: 'Draft the shortest usable generation direction grounded in the attached reference evidence. Preserve directly visible subjects, scene and styling; do not introduce a new subject, event, location, object, text or sound.',
  edit: 'Draft a conservative source-preserving edit direction. When no desired change is supplied, preserve the attached source instead of choosing an unrequested transformation, replacement or redesign.',
  extend: 'Draft a minimal continuation from the attached shot boundary or video source. Continue only motion or action that is directly evidenced, preserve continuity and introduce no new subject, event, location, camera move or sound.',
  transition: 'Create a minimal transition prompt that begins exactly on the ordered outgoing-shot end frame and finishes exactly on the incoming-shot start frame. This must be a bridge between both endpoints, never a standalone shot. Auto mode may choose only the minimum transition mechanism supported by their visible relationship; it must not add a subject, event, object, location, text, dialogue or sound.',
  angle: 'Choose one clear camera-view instruction only. The selected Angles tool authorizes camera position, elevation, lens perspective or framing, while the attached subject, identity, scene, moment, lighting and style remain unchanged.',
  'story-brief': 'Draft the smallest usable story premise around facts directly supported by the references. The Storyboard tool authorizes a minimal narrative premise, but not unsupported identities, named locations, backstory, dialogue or visual facts.',
  'story-scene': 'Draft one minimal scene that fits the read-only story context and attached references. Do not copy sibling-scene actions, fill unrelated omissions or add unsupported identities, dialogue or visual facts.',
  'multi-shot-scene': 'Draft one minimal shot that fits its position in the read-only sequence. Do not import sibling-shot actions or add unsupported subjects, locations, dialogue, camera moves or sound.',
  'character-notes': 'Describe only character traits directly visible in the attached sample and preserve every locked UI selection. Leave hidden, ambiguous and unselected traits or placements unspecified.',
  animation: 'Draft a minimal animation or motion-graphics direction using the attached assets and selected recipe for their stated roles. Do not invent claims, copy, data, branding, assets, transitions or sound content.',
  music: 'Draft a minimal music direction from the attached reference roles and usable metadata. Do not claim to hear or identify audio content that was not actually decoded, and do not invent instruments, genre, tempo, vocals or structure.',
  'single-sfx': 'Draft the smallest usable single-sound direction from the attached source role. Do not claim to hear undecoded audio or add a room, ambience, reverb, music, extra event or tail.',
  'foley-direction': 'Draft a minimal Foley direction from actions directly visible in sampled video frames. Do not infer off-screen action or add music, instrumentation, ambience or sound content from metadata-only audio.',
  avatar: 'Draft a neutral performance direction tied to the attached portrait, video and audio roles. Preserve the person and source scene; do not invent spoken words, timing, emotion, gaze or movement.',
  broll: 'Draft a minimal B-roll coverage instruction grounded in directly visible or supplied source facts. Do not invent story context, missing shots, stock availability or a new location, action or subject.',
  captions: 'Draft a minimal faithful captioning instruction for the attached source. Preserve wording and timing when they become available; do not invent dialogue, speakers, language, emphasis or styling details.',
  transcribe: 'Draft a minimal faithful transcription instruction for the attached audio or video role. Do not claim to hear metadata-only audio or invent language, vocabulary, speakers, words or timestamps.',
  beat: 'Draft a minimal non-destructive beat-analysis instruction for the attached audio role. Do not claim a tempo, beat position or song section before local analysis.',
  culling: 'Draft a minimal conservative culling instruction for the attached source scope. Default to review-only Keep, Maybe and Reject recommendations with reasons; never delete, move or alter source media.',
  workflow: 'Draft the shortest reviewable instruction for the selected tool using only the attached source roles and evidence. Do not add operations, decisions, media or deliverables beyond that tool’s stated purpose.',
}

function defaultPurpose(mediaKind: PromptEnhancementMediaKind): PromptEnhancementPurpose {
  return mediaKind === 'workflow' ? 'workflow' : mediaKind === 'audio' ? 'single-sfx' : 'create'
}

function isSeedance2Family(targetModel: string): boolean {
  return /^(seedance 2|seedance 2 fast|seedance 2 mini)$/i.test(targetModel.trim())
}

export function resolvePromptEnhancementProfile(
  targetModel: string,
  mediaKind: PromptEnhancementMediaKind,
  purpose: PromptEnhancementPurpose = defaultPurpose(mediaKind),
  inputMode: PromptEnhancementInputMode = 'rewrite',
): PromptEnhancementProfile {
  const seedance = isSeedance2Family(targetModel)
  return {
    id: seedance ? 'seedance-2' : 'adaptive',
    purpose,
    inputMode,
    purposeGuidance: inputMode === 'reference-draft' ? REFERENCE_DRAFT_GUIDANCE[purpose] : PURPOSE_GUIDANCE[purpose],
    modelGuidance: seedance
      ? 'Seedance 2 can use a longer chronological prompt when the user supplied multiple actions, timing, dialogue, reference roles or sound direction, or explicitly asked for a detailed expansion. Organize those existing facts clearly and in order. A simple request must still stay concise. Never add beats, time segments, camera moves, lighting, dialogue, music, sound, subjects or locations merely to make the prompt longer.'
      : 'Use the target model’s clearest compatible wording and structure, but adapt only the presentation of supplied facts. Model optimization never permits new creative facts or extra scope.',
  }
}
