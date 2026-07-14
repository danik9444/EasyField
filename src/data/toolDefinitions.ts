import type { GlyphName } from '../icons'
import type { MediaKind, ToolId, WorkspaceKind } from '../core/contracts'

export interface ToolRecipeDefinition {
  id: string
  name: string
  description: string
}

export interface ToolDefinition {
  id: ToolId
  name: string
  shortName?: string
  glyph: GlyphName
  description: string
  category: 'footage' | 'image' | 'video' | 'motion' | 'audio'
  workspace: WorkspaceKind
  sourceKinds: MediaKind[]
  outputKind?: MediaKind
  accent: string
  recipes: ToolRecipeDefinition[]
  privacy: 'local' | 'hybrid' | 'cloud'
  placement: boolean
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  { id: 'culling', name: 'Culling', glyph: 'cut', description: 'Review and sort footage conservatively', category: 'footage', workspace: 'analyze', sourceKinds: ['video'], accent: '#9BA3B5', privacy: 'local', placement: true, recipes: [{ id: 'review', name: 'Conservative review', description: 'Keep, Maybe, Reject with reasons' }, { id: 'selects', name: 'Build selects', description: 'Create a reviewed selects timeline' }] },
  { id: 'broll', name: 'B-roll', glyph: 'film', description: 'Find and fill missing coverage', category: 'footage', workspace: 'analyze', sourceKinds: ['video', 'transcript'], outputKind: 'video', accent: '#9BA3B5', privacy: 'hybrid', placement: true, recipes: [{ id: 'match', name: 'Match selected range', description: 'Project and Library first' }, { id: 'gaps', name: 'Find missing coverage', description: 'Propose AI shots without generating' }] },
  { id: 'upscale', name: 'Upscale', glyph: 'up', description: 'Batch-enhance stills and exact trimmed clips with Topaz', category: 'footage', workspace: 'edit', sourceKinds: ['image', 'video'], accent: '#9BA3B5', privacy: 'cloud', placement: true, recipes: [{ id: 'auto', name: 'Auto batch', description: 'Route every source to its matching Topaz image or video task' }] },
  { id: 'create-image', name: 'Create Image', glyph: 'img', description: 'Generate still frames from a prompt', category: 'image', workspace: 'generate', sourceKinds: ['image'], outputKind: 'image', accent: 'var(--ef-accent)', privacy: 'cloud', placement: true, recipes: [{ id: 'custom', name: 'Custom image', description: 'Prompt and references' }] },
  { id: 'storyboard', name: 'Storyboard', glyph: 'board', description: 'Turn a script into editable consistent shots', category: 'image', workspace: 'generate', sourceKinds: ['document', 'image'], outputKind: 'image', accent: 'var(--ef-accent)', privacy: 'cloud', placement: false, recipes: [{ id: 'script', name: 'Script to shots', description: 'One canonical frame per shot' }, { id: 'range', name: 'Range to storyboard', description: 'Plan coverage for a timeline range' }] },
  { id: 'character', name: 'Character', glyph: 'avatar', description: 'Design a consistent character from prompts and references', category: 'image', workspace: 'generate', sourceKinds: ['image'], outputKind: 'image', accent: 'var(--ef-accent)', privacy: 'cloud', placement: true, recipes: [{ id: 'design', name: 'Character design', description: 'Create a distinct visual identity' }, { id: 'sheet', name: 'Character sheet', description: 'Build consistent views and expressions' }] },
  { id: 'edit-image', name: 'Edit Image', glyph: 'edit', description: 'Prompt-edit a source image or paint a precise Inpaint mask', category: 'image', workspace: 'edit', sourceKinds: ['image'], outputKind: 'image', accent: 'var(--ef-accent)', privacy: 'hybrid', placement: true, recipes: [{ id: 'prompt', name: 'Prompt edit', description: 'Transform the primary image' }, { id: 'inpaint', name: 'Inpaint', description: 'Replace only a painted area' }] },
  { id: 'angles', name: 'Angles', glyph: 'angles', description: 'Orbit one source into consistent camera views', category: 'image', workspace: 'generate', sourceKinds: ['image'], outputKind: 'image', accent: 'var(--ef-accent)', privacy: 'cloud', placement: true, recipes: [{ id: 'random', name: 'Random angles', description: 'Generate a distinct coverage set' }, { id: 'custom', name: 'Custom angle', description: 'Direct one precise viewpoint' }] },
  { id: 'create-video', name: 'Create Video', glyph: 'vid', description: 'Generate a clip from text or references', category: 'video', workspace: 'generate', sourceKinds: ['image', 'video'], outputKind: 'video', accent: '#5B8CFF', privacy: 'cloud', placement: true, recipes: [{ id: 'custom', name: 'Custom video', description: 'Prompt and references' }] },
  { id: 'avatar', name: 'Avatar', glyph: 'avatar', description: 'Create a talking portrait or lip-sync a clip', category: 'video', workspace: 'generate', sourceKinds: ['image', 'video', 'audio'], outputKind: 'video', accent: '#5B8CFF', privacy: 'cloud', placement: true, recipes: [{ id: 'photo', name: 'Photo + audio', description: 'Animate a permitted portrait' }, { id: 'lipsync', name: 'Video lip sync', description: 'Synchronize an existing performance' }] },
  { id: 'edit-video', name: 'Edit Video', glyph: 'editv', description: 'Transform a primary clip with verified video-reference models', category: 'video', workspace: 'edit', sourceKinds: ['video'], outputKind: 'video', accent: '#5B8CFF', privacy: 'cloud', placement: true, recipes: [{ id: 'prompt', name: 'Prompt edit', description: 'Transform an existing clip with references' }] },
  { id: 'extend', name: 'Extend Video', glyph: 'extend', description: 'Continue a shot forward with a compatible model', category: 'video', workspace: 'edit', sourceKinds: ['video'], outputKind: 'video', accent: '#5B8CFF', privacy: 'cloud', placement: true, recipes: [{ id: 'forward', name: 'Continue forward', description: 'Extend from the final frame' }, { id: 'backward', name: 'Continue backward', description: 'Planned when a verified adapter is available' }] },
  { id: 'transition', name: 'Transition', glyph: 'trans', description: 'Generate a bridge between adjacent shots', category: 'video', workspace: 'generate', sourceKinds: ['image', 'video'], outputKind: 'video', accent: '#5B8CFF', privacy: 'cloud', placement: true, recipes: [{ id: 'bridge', name: 'AI bridge', description: 'Last frame to first frame' }, { id: 'subtle', name: 'Subtle morph', description: 'Low-motion visual continuity' }] },
  { id: 'animations', name: 'Animations', glyph: 'anim', description: 'Build motion graphics through a safe AI chat', category: 'motion', workspace: 'chat', sourceKinds: ['document', 'image', 'video', 'audio'], outputKind: 'video', accent: '#FFB454', privacy: 'hybrid', placement: true, recipes: [{ id: 'title', name: 'Kinetic title', description: 'Typography-led motion' }, { id: 'explainer', name: 'Faceless explainer', description: 'Multi-scene visual story' }] },
  { id: 'captions', name: 'Captions', glyph: 'cap', description: 'Native or styled subtitles from one transcript', category: 'motion', workspace: 'edit', sourceKinds: ['transcript', 'audio', 'video'], outputKind: 'transcript', accent: '#FFB454', privacy: 'local', placement: true, recipes: [{ id: 'native', name: 'Native subtitles', description: 'Editable Resolve subtitle track' }, { id: 'styled', name: 'Styled captions', description: 'Fusion Titles with alpha fallback' }] },
  { id: 'music', name: 'Create Music', glyph: 'music', description: 'Generate a score or custom track', category: 'audio', workspace: 'generate', sourceKinds: ['audio', 'video'], outputKind: 'audio', accent: '#3ED598', privacy: 'cloud', placement: true, recipes: [{ id: 'score', name: 'Score selected range', description: 'Compose against the edit' }, { id: 'custom', name: 'Custom track', description: 'Mood, duration and structure' }] },
  { id: 'sfx', name: 'Sound Effects', glyph: 'sfx', description: 'Create standalone sounds or reviewed timed Foley', category: 'audio', workspace: 'generate', sourceKinds: ['video'], outputKind: 'audio', accent: '#3ED598', privacy: 'hybrid', placement: true, recipes: [{ id: 'single', name: 'Single sound', description: 'One standalone effect from text' }, { id: 'foley', name: 'Auto Foley', description: 'Analyze video, review timed events, then generate' }] },
  { id: 'vo', name: 'Voice Over', glyph: 'vo', description: 'Create line-based narration', category: 'audio', workspace: 'generate', sourceKinds: ['transcript'], outputKind: 'audio', accent: '#3ED598', privacy: 'cloud', placement: true, recipes: [{ id: 'script', name: 'Narration', description: 'Generate a script line by line' }, { id: 'transcript', name: 'Selected transcript', description: 'Voice the current selection' }] },
  { id: 'transcribe', name: 'Transcribe', glyph: 'transcribe', description: 'Editable local transcripts in 100 languages', category: 'audio', workspace: 'analyze', sourceKinds: ['audio', 'video'], outputKind: 'transcript', accent: '#3ED598', privacy: 'local', placement: false, recipes: [{ id: 'local', name: 'OpenAI Whisper local', description: 'Private, downloadable and offline' }] },
  { id: 'beat', name: 'Beat Detection', glyph: 'beat', description: 'Detect rhythm and import audio with reviewed markers', category: 'audio', workspace: 'analyze', sourceKinds: ['audio'], accent: '#3ED598', privacy: 'local', placement: true, recipes: [{ id: 'markers', name: 'Beat map', description: 'Local librosa analysis with precise marker filtering' }] },
]

export const TOOL_BY_ID = Object.fromEntries(TOOL_DEFINITIONS.map((tool) => [tool.id, tool])) as Record<ToolId, ToolDefinition>
