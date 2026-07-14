import type { GlyphName } from '../icons'
import type { ToolId } from '../core/contracts'
import { TOOL_DEFINITIONS } from './toolDefinitions'

export interface Tool {
  id: ToolId
  name: string
  glyph: GlyphName
  desc: string
  availability: 'available'
}

export interface Category {
  id: string
  label: string
  color: string
  tint: string
  tools: Tool[]
}

const ACCENT = 'var(--ef-accent)'

const CATEGORY_META: Record<Tool['id'] extends never ? never : string, { label: string; color: string; tint: string }> = {
  footage: { label: 'Footage', color: '#9BA3B5', tint: 'rgba(155,163,181,.12)' },
  image: { label: 'Image', color: ACCENT, tint: 'color-mix(in srgb, var(--ef-accent) 13%, transparent)' },
  video: { label: 'Video', color: '#5B8CFF', tint: 'rgba(91,140,255,.13)' },
  motion: { label: 'Motion', color: '#FFB454', tint: 'rgba(255,180,84,.13)' },
  audio: { label: 'Audio', color: '#3ED598', tint: 'rgba(62,213,152,.13)' },
}

export const CATALOG: Category[] = (['footage', 'image', 'video', 'motion', 'audio'] as const).map((id) => ({
  id,
  ...CATEGORY_META[id],
  tools: TOOL_DEFINITIONS.filter((tool) => tool.category === id).map((tool) => ({
    id: tool.id,
    name: tool.name,
    glyph: tool.glyph,
    desc: tool.description,
    availability: 'available' as const,
  })),
}))

export const TOOL_COUNT = CATALOG.reduce((n, c) => n + c.tools.length, 0)
