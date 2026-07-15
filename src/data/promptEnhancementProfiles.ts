export type PromptEnhancementMediaKind = 'image' | 'video' | 'audio' | 'workflow'

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
  | 'workflow'

export interface PromptEnhancementProfile {
  id: 'adaptive' | 'seedance-2'
  purpose: PromptEnhancementPurpose
  purposeGuidance: string
  modelGuidance: string
}

const PURPOSE_GUIDANCE: Record<PromptEnhancementPurpose, string> = {
  create: 'Clarify the requested generation. Use only subjects, actions, setting, style and technical choices that the user selected, wrote, or supplied as evidence.',
  edit: 'Describe only the requested change. Preserve every property of the primary source that the user did not ask to change, including identity, composition, timing, motion, lighting, sound and background.',
  extend: 'Describe only the requested continuation from the supplied source. Preserve continuity and do not introduce a new event, subject, location, camera move or sound unless the user requested it.',
  transition: 'Clarify only the requested bridge between the supplied boundary frames. Do not invent narrative events, subjects or locations between them.',
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
  workflow: 'Clarify the requested workflow while keeping its scope reviewable and non-destructive. Do not add operations, media, decisions or deliverables the user did not request.',
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
): PromptEnhancementProfile {
  const seedance = isSeedance2Family(targetModel)
  return {
    id: seedance ? 'seedance-2' : 'adaptive',
    purpose,
    purposeGuidance: PURPOSE_GUIDANCE[purpose],
    modelGuidance: seedance
      ? 'Seedance 2 can use a longer chronological prompt when the user supplied multiple actions, timing, dialogue, reference roles or sound direction, or explicitly asked for a detailed expansion. Organize those existing facts clearly and in order. A simple request must still stay concise. Never add beats, time segments, camera moves, lighting, dialogue, music, sound, subjects or locations merely to make the prompt longer.'
      : 'Use the target model’s clearest compatible wording and structure, but adapt only the presentation of supplied facts. Model optimization never permits new creative facts or extra scope.',
  }
}
