export type ToolId =
  | 'culling'
  | 'broll'
  | 'upscale'
  | 'create-image'
  | 'storyboard'
  | 'character'
  | 'avatar'
  | 'edit-image'
  | 'angles'
  | 'create-video'
  | 'edit-video'
  | 'extend'
  | 'transition'
  | 'animations'
  | 'captions'
  | 'music'
  | 'sfx'
  | 'vo'
  | 'transcribe'
  | 'beat'

export type WorkspaceKind = 'generate' | 'edit' | 'analyze' | 'chat'
export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'transcript'
export type PlacementMode = 'playhead' | 'replace' | 'append' | 'media-pool'

export interface ModelCapability {
  id: string
  label: string
  value?: string
}

export interface ModelDefinition {
  id: string
  name: string
  provider: 'cloud' | 'local' | 'resolve'
  tools: ToolId[]
  inputKinds: MediaKind[]
  outputKinds: MediaKind[]
  capabilities: ModelCapability[]
  recommendedFor: string[]
  recommendation?: 'best' | 'fast' | 'value'
  recommendationReason?: string
  priceCredits?: number
  priceUnit?: string
  validated: boolean
  available: boolean
  unavailableReason?: string
}

export interface ProjectContext {
  projectId: string
  projectName: string
  timelineId?: string
  timelineName?: string
  revision?: string
  fps?: number
  width?: number
  height?: number
  colorSpace?: string
  connected: boolean
}

export interface TimelineSnapshot extends ProjectContext {
  playhead?: string
  selectedClipIds: string[]
  selectedRange?: { start: string; end: string }
  lockedTracks: string[]
}

export interface PlacementRequest {
  artifactIds: string[]
  mode: PlacementMode
  targetTimelineId?: string
  targetTrack?: string
  playhead?: string
  expectedRevision?: string
  requireConfirmation: boolean
}

export interface TimelineOperation {
  id: string
  toolId: ToolId
  label: string
  destructive: boolean
  dependsOn: string[]
  placement?: PlacementRequest
}

export interface TimelinePlan {
  id: string
  projectId: string
  baseRevision?: string
  operations: TimelineOperation[]
  maxCredits: number
  uploadManifest: UploadManifestItem[]
  status: 'draft' | 'needs-input' | 'approved' | 'running' | 'paused' | 'completed' | 'rolled-back'
}

export interface UndoToken {
  id: string
  planId: string
  operationId: string
  createdAt: number
  backupArtifactIds: string[]
}

export interface UploadManifestItem {
  assetId: string
  kind: MediaKind
  label: string
  provider: string
  model: string
  purpose: string
  bytes?: number
  consentRequired: boolean
}

export interface GenerationCommand {
  id: string
  toolId: ToolId
  projectId: string
  modelId: string
  prompt?: string
  inputs: string[]
  outputCount: number
  maxCredits: number
  placement: PlacementRequest
  uploadManifest: UploadManifestItem[]
  createdAt: number
}

export type DurableJobStatus =
  | 'preparing'
  | 'awaiting-approval'
  | 'queued'
  | 'running'
  | 'downloading'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled'

export interface GenerationJob {
  id: string
  parentJobId?: string
  command: GenerationCommand
  providerTaskIds: string[]
  status: DurableJobStatus
  progress?: number
  estimatedCredits: number
  actualCredits?: number
  artifactIds: string[]
  error?: string
  recoverable: boolean
  createdAt: number
  updatedAt: number
}

export interface Artifact {
  id: string
  projectId: string
  kind: MediaKind
  name: string
  localPath?: string
  previewUrl?: string
  mimeType?: string
  bytes?: number
  durationSeconds?: number
  width?: number
  height?: number
  checksum?: string
  source: 'provider' | 'local' | 'resolve' | 'render'
  providerTaskId?: string
  parentArtifactId?: string
  importedToMediaPool: boolean
  placedOnTimeline: boolean
  referenced: boolean
  createdAt: number
}

export interface Draft<TState = Record<string, unknown>> {
  id: string
  projectId: string
  toolId: ToolId
  recipeId?: string
  recipeVersion?: number
  state: TState
  attachmentArtifactIds: string[]
  resultArtifactIds: string[]
  updatedAt: number
}

export interface Recipe<TState = Record<string, unknown>> {
  id: string
  projectId?: string
  toolId: ToolId
  name: string
  version: number
  state: TState
  builtIn: boolean
  updatedAt: number
}

export interface TranscriptWord {
  id: string
  text: string
  startSeconds: number
  endSeconds: number
  confidence?: number
  speakerId?: string
}

export interface TranscriptDocument {
  id: string
  projectId: string
  sourceArtifactId: string
  /** Canonical Whisper language code, or `mixed` when auto-detection is inconclusive. */
  language: string
  engine: 'local' | 'cloud'
  words: TranscriptWord[]
  revision: number
  updatedAt: number
}

export type CompositionLayerType = 'text' | 'image' | 'video' | 'shape' | 'icon' | 'chart' | 'caption'

export interface CompositionLayer {
  id: string
  type: CompositionLayerType
  start: number
  duration: number
  sourceArtifactId?: string
  text?: string
  animation?: string
}

export interface CompositionScene {
  id: string
  start: number
  duration: number
  transition?: string
  layers: CompositionLayer[]
}

export interface CompositionSpec {
  schemaVersion: 1
  id: string
  projectId: string
  revision: number
  brief: string
  engine: 'hyperframes' | 'remotion'
  canvas: { width: number; height: number; fps: number; background: string }
  sourceArtifactIds: string[]
  scenes: CompositionScene[]
  createdAt: number
}

export interface SpecPatch {
  compositionId: string
  baseRevision: number
  operations: Array<
    | { type: 'replace-text'; layerId: string; text: string }
    | { type: 'set-duration'; sceneId: string; duration: number }
    | { type: 'set-animation'; layerId: string; animation: string }
    | { type: 'remove-layer'; layerId: string }
  >
}
