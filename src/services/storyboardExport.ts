import { formatStoryboardDuration, formatStoryboardTimecode, type StoryboardTimingMode } from '../data/storyboard'

export interface StoryboardExportScene {
  ordinal: number
  title: string
  description: string
  explanation: string
  durationSeconds: number
  startSeconds: number
  imageUrl: string
}

export interface StoryboardExportInput {
  title: string
  story: string
  aspect: string
  timingMode: StoryboardTimingMode
  totalDurationSeconds: number
  scenes: StoryboardExportScene[]
}

const CANVAS_WIDTH = 1_920
const CHROME_SAFE_CANVAS_HEIGHT = 32_700
const MAX_SCENES = 20
const IMAGE_TIMEOUT_MS = 30_000

const COLOR = {
  canvas: '#08080c',
  canvasRaised: '#0d0d13',
  surface: '#15151d',
  surfaceSoft: '#111118',
  line: 'rgba(255, 255, 255, 0.10)',
  lineBright: 'rgba(255, 255, 255, 0.17)',
  ink: '#f8f7fb',
  inkSoft: '#c9c7d2',
  inkMuted: '#858394',
  inkFaint: '#5d5b69',
  blue: '#6f95ff',
  purple: '#a878ff',
  pink: '#ee74d7',
  green: '#42dfa2',
  amber: '#ffbd6a',
} as const

interface TypographyProfile {
  name: 'normal' | 'compact' | 'dense'
  safeHeight: number
  font: {
    brand: string
    meta: string
    pageTitle: string
    story: string
    cardTitle: string
    description: string
    explanation: string
    sceneNumber: string
    sectionLabel: string
    footer: string
  }
  lineHeight: {
    pageTitle: number
    story: number
    cardTitle: number
    description: number
    explanation: number
    label: number
  }
  spacing: {
    pagePadding: number
    columnGap: number
    rowGap: number
    cardPadding: number
    titleY: number
    titleToStory: number
    storyTopPadding: number
    storyLabelGap: number
    storyBottomPadding: number
    headerBottomGap: number
    cardHeaderMinHeight: number
    cardHeaderGap: number
    frameToLabel: number
    labelToCopy: number
    sectionGap: number
    cardBottomPadding: number
    badgeSize: number
    badgeToTitle: number
    footerGap: number
    footerHeight: number
  }
}

const NORMAL_PROFILE: TypographyProfile = {
  name: 'normal',
  // Existing exports keep their exact visual treatment while they remain in
  // the original, broadly-supported canvas envelope.
  safeHeight: 16_000,
  font: {
    brand: '650 24px "Space Grotesk Variable", "Space Grotesk", sans-serif',
    meta: '600 17px "JetBrains Mono Variable", "JetBrains Mono", monospace',
    pageTitle: '700 68px "Space Grotesk Variable", "Space Grotesk", sans-serif',
    story: '430 30px "Instrument Sans Variable", "Instrument Sans", sans-serif',
    cardTitle: '660 31px "Space Grotesk Variable", "Space Grotesk", sans-serif',
    description: '450 27px "Instrument Sans Variable", "Instrument Sans", sans-serif',
    explanation: '430 24px "Instrument Sans Variable", "Instrument Sans", sans-serif',
    sceneNumber: '680 20px "JetBrains Mono Variable", "JetBrains Mono", monospace',
    sectionLabel: '650 17px "JetBrains Mono Variable", "JetBrains Mono", monospace',
    footer: '600 16px "JetBrains Mono Variable", "JetBrains Mono", monospace',
  },
  lineHeight: {
    pageTitle: 80,
    story: 42,
    cardTitle: 39,
    description: 36,
    explanation: 32,
    label: 17,
  },
  spacing: {
    pagePadding: 84,
    columnGap: 32,
    rowGap: 34,
    cardPadding: 28,
    titleY: 158,
    titleToStory: 38,
    storyTopPadding: 32,
    storyLabelGap: 24,
    storyBottomPadding: 34,
    headerBottomGap: 62,
    cardHeaderMinHeight: 54,
    cardHeaderGap: 24,
    frameToLabel: 32,
    labelToCopy: 18,
    sectionGap: 28,
    cardBottomPadding: 32,
    badgeSize: 54,
    badgeToTitle: 22,
    footerGap: 52,
    footerHeight: 82,
  },
}

const COMPACT_PROFILE: TypographyProfile = {
  name: 'compact',
  safeHeight: 24_000,
  font: {
    brand: '650 22px "Space Grotesk Variable", "Space Grotesk", sans-serif',
    meta: '600 15px "JetBrains Mono Variable", "JetBrains Mono", monospace',
    pageTitle: '700 58px "Space Grotesk Variable", "Space Grotesk", sans-serif',
    story: '430 24px "Instrument Sans Variable", "Instrument Sans", sans-serif',
    cardTitle: '660 27px "Space Grotesk Variable", "Space Grotesk", sans-serif',
    description: '450 22px "Instrument Sans Variable", "Instrument Sans", sans-serif',
    explanation: '430 20px "Instrument Sans Variable", "Instrument Sans", sans-serif',
    sceneNumber: '680 18px "JetBrains Mono Variable", "JetBrains Mono", monospace',
    sectionLabel: '650 15px "JetBrains Mono Variable", "JetBrains Mono", monospace',
    footer: '600 15px "JetBrains Mono Variable", "JetBrains Mono", monospace',
  },
  lineHeight: {
    pageTitle: 68,
    story: 33,
    cardTitle: 34,
    description: 29,
    explanation: 27,
    label: 15,
  },
  spacing: {
    pagePadding: 70,
    columnGap: 26,
    rowGap: 27,
    cardPadding: 24,
    titleY: 146,
    titleToStory: 32,
    storyTopPadding: 27,
    storyLabelGap: 20,
    storyBottomPadding: 29,
    headerBottomGap: 48,
    cardHeaderMinHeight: 48,
    cardHeaderGap: 20,
    frameToLabel: 27,
    labelToCopy: 15,
    sectionGap: 23,
    cardBottomPadding: 27,
    badgeSize: 48,
    badgeToTitle: 19,
    footerGap: 42,
    footerHeight: 72,
  },
}

const DENSE_PROFILE: TypographyProfile = {
  name: 'dense',
  safeHeight: CHROME_SAFE_CANVAS_HEIGHT,
  font: {
    brand: '650 19px "Space Grotesk Variable", "Space Grotesk", sans-serif',
    meta: '600 13px "JetBrains Mono Variable", "JetBrains Mono", monospace',
    pageTitle: '700 44px "Space Grotesk Variable", "Space Grotesk", sans-serif',
    story: '430 14px "Instrument Sans Variable", "Instrument Sans", sans-serif',
    cardTitle: '660 20px "Space Grotesk Variable", "Space Grotesk", sans-serif',
    description: '450 13px "Instrument Sans Variable", "Instrument Sans", sans-serif',
    explanation: '430 12px "Instrument Sans Variable", "Instrument Sans", sans-serif',
    sceneNumber: '680 14px "JetBrains Mono Variable", "JetBrains Mono", monospace',
    sectionLabel: '650 12px "JetBrains Mono Variable", "JetBrains Mono", monospace',
    footer: '600 12px "JetBrains Mono Variable", "JetBrains Mono", monospace',
  },
  lineHeight: {
    pageTitle: 52,
    story: 19,
    cardTitle: 25,
    description: 17,
    explanation: 16,
    label: 12,
  },
  spacing: {
    pagePadding: 48,
    columnGap: 18,
    rowGap: 18,
    cardPadding: 18,
    titleY: 132,
    titleToStory: 24,
    storyTopPadding: 20,
    storyLabelGap: 14,
    storyBottomPadding: 22,
    headerBottomGap: 34,
    cardHeaderMinHeight: 40,
    cardHeaderGap: 14,
    frameToLabel: 20,
    labelToCopy: 11,
    sectionGap: 16,
    cardBottomPadding: 20,
    badgeSize: 40,
    badgeToTitle: 15,
    footerGap: 30,
    footerHeight: 62,
  },
}

const TYPOGRAPHY_PROFILES = [NORMAL_PROFILE, COMPACT_PROFILE, DENSE_PROFILE] as const

interface WrappedBlock {
  lines: string[]
  direction: 'ltr' | 'rtl'
  height: number
}

interface SceneLayout {
  scene: StoryboardExportScene
  x: number
  y: number
  width: number
  height: number
  headerHeight: number
  frameX: number
  frameY: number
  frameWidth: number
  frameHeight: number
  title: WrappedBlock
  description: WrappedBlock
  explanation: WrappedBlock
}

interface HeaderLayout {
  title: WrappedBlock
  story: WrappedBlock
  titleY: number
  storyPanelY: number
  storyPanelHeight: number
  bottom: number
}

function cleanText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : ''
}

/**
 * Preserve ordinary authored line breaks, collapse repeated blank lines, and
 * treat line breaks as soft wrapping only when a text contains an excessive
 * number of them. This keeps every word while preventing pasted hard-wrapped
 * (or one-word-per-line) text from creating an artificial canvas overflow.
 */
function normalizeLayoutText(value: string | null | undefined): string {
  const cleaned = cleanText(value)
  if (!cleaned) return ''

  const collapsedBlankLines: string[] = []
  let previousWasBlank = false
  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.trim()
    const blank = line.length === 0
    if (blank && previousWasBlank) continue
    collapsedBlankLines.push(line)
    previousWasBlank = blank
  }

  const normalized = collapsedBlankLines.join('\n').trim()
  const contentLines = collapsedBlankLines.filter(Boolean)
  const averageLineLength = contentLines.length
    ? contentLines.reduce((total, line) => total + line.length, 0) / contentLines.length
    : 0
  const excessiveHardBreaks = contentLines.length > 64
    || (contentLines.length > 20 && averageLineLength < 16)

  if (!excessiveHardBreaks) return normalized

  return normalized
    .split(/\n[ \t]*\n+/u)
    .map((paragraph) => paragraph
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' '))
    .filter(Boolean)
    .join('\n')
}

function directionFor(text: string): 'ltr' | 'rtl' {
  const rtl = text.match(/[\u0590-\u08ff\ufb1d-\ufefc]/g)?.length ?? 0
  const ltr = text.match(/[A-Za-z\u00c0-\u02af]/g)?.length ?? 0
  return rtl > ltr ? 'rtl' : 'ltr'
}

function splitOversizedWord(
  context: CanvasRenderingContext2D,
  word: string,
  maxWidth: number,
): string[] {
  const parts: string[] = []
  let current = ''

  for (const character of Array.from(word)) {
    const candidate = current + character
    if (current && context.measureText(candidate).width > maxWidth) {
      parts.push(current)
      current = character
    } else {
      current = candidate
    }
  }

  if (current) parts.push(current)
  return parts.length ? parts : ['']
}

function wrapParagraph(
  context: CanvasRenderingContext2D,
  paragraph: string,
  maxWidth: number,
): string[] {
  if (!paragraph.trim()) return ['']

  const lines: string[] = []
  let current = ''
  const words = paragraph.trim().split(/\s+/u)

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (context.measureText(candidate).width <= maxWidth) {
      current = candidate
      continue
    }

    if (current) {
      lines.push(current)
      current = ''
    }

    if (context.measureText(word).width <= maxWidth) {
      current = word
      continue
    }

    const pieces = splitOversizedWord(context, word, maxWidth)
    lines.push(...pieces.slice(0, -1))
    current = pieces.at(-1) ?? ''
  }

  if (current) lines.push(current)
  return lines.length ? lines : ['']
}

function wrapBlock(
  context: CanvasRenderingContext2D,
  text: string,
  font: string,
  maxWidth: number,
  lineHeight: number,
): WrappedBlock {
  context.font = font
  const normalized = normalizeLayoutText(text)
  const lines = normalized
    ? normalized.split('\n').flatMap((paragraph) => wrapParagraph(context, paragraph, maxWidth))
    : ['—']

  return {
    lines,
    direction: directionFor(normalized),
    height: lines.length * lineHeight,
  }
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2))
  context.beginPath()
  context.moveTo(x + safeRadius, y)
  context.lineTo(x + width - safeRadius, y)
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius)
  context.lineTo(x + width, y + height - safeRadius)
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height)
  context.lineTo(x + safeRadius, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius)
  context.lineTo(x, y + safeRadius)
  context.quadraticCurveTo(x, y, x + safeRadius, y)
  context.closePath()
}

function fillRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fill: string | CanvasGradient,
): void {
  roundedRect(context, x, y, width, height, radius)
  context.fillStyle = fill
  context.fill()
}

function strokeRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  stroke: string,
  lineWidth = 1,
): void {
  roundedRect(context, x, y, width, height, radius)
  context.strokeStyle = stroke
  context.lineWidth = lineWidth
  context.stroke()
}

function drawBlock(
  context: CanvasRenderingContext2D,
  block: WrappedBlock,
  x: number,
  y: number,
  width: number,
  font: string,
  lineHeight: number,
  color: string,
): void {
  context.save()
  context.font = font
  context.fillStyle = color
  context.textBaseline = 'top'
  context.direction = block.direction
  context.textAlign = block.direction === 'rtl' ? 'right' : 'left'
  const anchorX = block.direction === 'rtl' ? x + width : x

  block.lines.forEach((line, index) => {
    if (line) context.fillText(line, anchorX, y + index * lineHeight)
  })
  context.restore()
}

function drawLabel(
  context: CanvasRenderingContext2D,
  label: string,
  x: number,
  y: number,
  profile: TypographyProfile,
  color: string = COLOR.inkMuted,
): void {
  context.save()
  context.font = profile.font.sectionLabel
  context.fillStyle = color
  context.textAlign = 'left'
  context.textBaseline = 'top'
  context.direction = 'ltr'
  context.fillText(label, x, y)
  context.restore()
}

async function waitForProductFonts(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return

  try {
    await Promise.all([
      document.fonts.ready,
      document.fonts.load('700 68px "Space Grotesk Variable"'),
      document.fonts.load('450 30px "Instrument Sans Variable"'),
      document.fonts.load('650 17px "JetBrains Mono Variable"'),
    ])
  } catch {
    // A platform fallback remains in every font stack, so export can continue.
  }
}

function sceneDescriptor(scene: StoryboardExportScene): string {
  const title = cleanText(scene.title)
  return `Scene ${scene.ordinal}${title ? ` (“${title.slice(0, 72)}”)` : ''}`
}

function imageSourceFor(scene: StoryboardExportScene): string {
  const source = cleanText(scene.imageUrl)
  if (!source) throw new Error(`${sceneDescriptor(scene)} has no image to export.`)

  let parsed: URL
  try {
    parsed = new URL(source, document.baseURI)
  } catch {
    throw new Error(`${sceneDescriptor(scene)} has an invalid image URL.`)
  }

  if (!['blob:', 'data:', 'http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${sceneDescriptor(scene)} uses an unsupported image URL.`)
  }
  return parsed.href
}

async function loadSceneImage(scene: StoryboardExportScene): Promise<HTMLImageElement> {
  const source = imageSourceFor(scene)

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image()
    let settled = false
    const timeout = window.setTimeout(() => {
      if (settled) return
      settled = true
      element.onload = null
      element.onerror = null
      reject(new Error(`${sceneDescriptor(scene)} timed out while loading its image.`))
    }, IMAGE_TIMEOUT_MS)

    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      element.onload = null
      element.onerror = null
      callback()
    }

    element.decoding = 'async'
    element.loading = 'eager'
    if (source.startsWith('http:') || source.startsWith('https:')) {
      element.crossOrigin = 'anonymous'
    }
    element.onload = () => finish(() => {
      if (element.naturalWidth > 0 && element.naturalHeight > 0) resolve(element)
      else reject(new Error(`${sceneDescriptor(scene)} loaded an empty image.`))
    })
    element.onerror = () => finish(() => reject(new Error(
      `${sceneDescriptor(scene)} could not load its image. The source may be unavailable or may not allow cross-origin image export.`,
    )))
    element.src = source
  })

  const probe = document.createElement('canvas')
  probe.width = 1
  probe.height = 1
  const probeContext = probe.getContext('2d')
  if (!probeContext) throw new Error('This browser cannot verify storyboard images for export.')

  try {
    probeContext.drawImage(image, 0, 0, 1, 1)
    probeContext.getImageData(0, 0, 1, 1)
  } catch {
    throw new Error(
      `${sceneDescriptor(scene)} cannot be included because its image source does not permit canvas export.`,
    )
  }

  return image
}

function measureHeader(
  context: CanvasRenderingContext2D,
  titleText: string,
  storyText: string,
  profile: TypographyProfile,
): HeaderLayout {
  const { spacing, font, lineHeight } = profile
  const contentWidth = CANVAS_WIDTH - spacing.pagePadding * 2
  const titleY = spacing.titleY
  const title = wrapBlock(
    context,
    titleText || 'Untitled Storyboard',
    font.pageTitle,
    contentWidth,
    lineHeight.pageTitle,
  )
  const storyPanelY = titleY + title.height + spacing.titleToStory
  const storyHorizontalPadding = Math.min(32, spacing.pagePadding / 2)
  const storyWidth = contentWidth - storyHorizontalPadding * 2
  const story = wrapBlock(
    context,
    storyText || 'No full-story summary was provided.',
    font.story,
    storyWidth,
    lineHeight.story,
  )
  const storyPanelHeight = spacing.storyTopPadding
    + lineHeight.label
    + spacing.storyLabelGap
    + story.height
    + spacing.storyBottomPadding

  return {
    title,
    story,
    titleY,
    storyPanelY,
    storyPanelHeight,
    bottom: storyPanelY + storyPanelHeight + spacing.headerBottomGap,
  }
}

function measureScene(
  context: CanvasRenderingContext2D,
  scene: StoryboardExportScene,
  width: number,
  profile: TypographyProfile,
): Omit<SceneLayout, 'x' | 'y' | 'height'> & { naturalHeight: number } {
  const { spacing, font, lineHeight } = profile
  const innerWidth = width - spacing.cardPadding * 2
  const titleWidth = innerWidth - spacing.badgeSize - spacing.badgeToTitle
  const title = wrapBlock(
    context,
    cleanText(scene.title) || `Scene ${scene.ordinal}`,
    font.cardTitle,
    titleWidth,
    lineHeight.cardTitle,
  )
  const description = wrapBlock(
    context,
    cleanText(scene.description),
    font.description,
    innerWidth,
    lineHeight.description,
  )
  const explanation = wrapBlock(
    context,
    cleanText(scene.explanation),
    font.explanation,
    innerWidth,
    lineHeight.explanation,
  )
  const headerHeight = Math.max(spacing.cardHeaderMinHeight, title.height)
  const frameWidth = innerWidth
  const frameHeight = frameWidth * 9 / 16
  const naturalHeight = spacing.cardPadding
    + headerHeight
    + spacing.cardHeaderGap
    + frameHeight
    + spacing.frameToLabel
    + lineHeight.label
    + spacing.labelToCopy
    + description.height
    + spacing.sectionGap
    + lineHeight.label
    + spacing.labelToCopy
    + explanation.height
    + spacing.cardBottomPadding

  return {
    scene,
    width,
    naturalHeight,
    headerHeight,
    frameX: 0,
    frameY: 0,
    frameWidth,
    frameHeight,
    title,
    description,
    explanation,
  }
}

function buildSceneLayouts(
  context: CanvasRenderingContext2D,
  scenes: StoryboardExportScene[],
  startY: number,
  profile: TypographyProfile,
): { layouts: SceneLayout[]; bottom: number } {
  const { spacing } = profile
  const contentWidth = CANVAS_WIDTH - spacing.pagePadding * 2
  const columns = scenes.length === 1 ? 1 : 2
  const cardWidth = (contentWidth - spacing.columnGap * (columns - 1)) / columns
  const measured = scenes.map((scene) => measureScene(context, scene, cardWidth, profile))
  const layouts: SceneLayout[] = []
  let y = startY

  for (let rowStart = 0; rowStart < measured.length; rowStart += columns) {
    const row = measured.slice(rowStart, rowStart + columns)
    const rowHeight = Math.max(...row.map((scene) => scene.naturalHeight))

    row.forEach((scene, column) => {
      const x = spacing.pagePadding + column * (cardWidth + spacing.columnGap)
      const frameX = x + spacing.cardPadding
      const frameY = y + spacing.cardPadding + scene.headerHeight + spacing.cardHeaderGap
      layouts.push({
        ...scene,
        x,
        y,
        height: rowHeight,
        frameX,
        frameY,
      })
    })
    y += rowHeight + spacing.rowGap
  }

  return { layouts, bottom: y - spacing.rowGap }
}

function drawBackground(context: CanvasRenderingContext2D, height: number): void {
  context.fillStyle = COLOR.canvas
  context.fillRect(0, 0, CANVAS_WIDTH, height)

  const blueGlow = context.createRadialGradient(170, 0, 0, 170, 0, 760)
  blueGlow.addColorStop(0, 'rgba(111, 149, 255, 0.19)')
  blueGlow.addColorStop(1, 'rgba(111, 149, 255, 0)')
  context.fillStyle = blueGlow
  context.fillRect(0, 0, CANVAS_WIDTH, Math.min(1_100, height))

  const pinkGlow = context.createRadialGradient(CANVAS_WIDTH - 90, 60, 0, CANVAS_WIDTH - 90, 60, 700)
  pinkGlow.addColorStop(0, 'rgba(238, 116, 215, 0.15)')
  pinkGlow.addColorStop(1, 'rgba(238, 116, 215, 0)')
  context.fillStyle = pinkGlow
  context.fillRect(850, 0, CANVAS_WIDTH - 850, Math.min(1_000, height))

  context.save()
  context.strokeStyle = 'rgba(255, 255, 255, 0.018)'
  context.lineWidth = 1
  for (let x = 0; x <= CANVAS_WIDTH; x += 64) {
    context.beginPath()
    context.moveTo(x + 0.5, 0)
    context.lineTo(x + 0.5, height)
    context.stroke()
  }
  for (let y = 0; y <= height; y += 64) {
    context.beginPath()
    context.moveTo(0, y + 0.5)
    context.lineTo(CANVAS_WIDTH, y + 0.5)
    context.stroke()
  }
  context.restore()
}

function drawHeader(
  context: CanvasRenderingContext2D,
  layout: HeaderLayout,
  aspect: string,
  sceneCount: number,
  totalDurationSeconds: number,
  includeTiming: boolean,
  profile: TypographyProfile,
): void {
  const { spacing, font, lineHeight } = profile
  const pagePadding = spacing.pagePadding
  const contentWidth = CANVAS_WIDTH - pagePadding * 2
  const storyHorizontalPadding = Math.min(32, pagePadding / 2)
  const brandGradient = context.createLinearGradient(pagePadding, 70, pagePadding + 48, 118)
  brandGradient.addColorStop(0, COLOR.blue)
  brandGradient.addColorStop(0.52, COLOR.purple)
  brandGradient.addColorStop(1, COLOR.pink)
  fillRoundedRect(context, pagePadding, 70, 48, 48, 14, brandGradient)

  context.save()
  context.translate(pagePadding + 24, 94)
  context.rotate(Math.PI / 4)
  context.fillStyle = '#110b17'
  context.fillRect(-7, -7, 14, 14)
  context.restore()

  context.save()
  context.font = font.brand
  context.fillStyle = COLOR.ink
  context.textBaseline = 'middle'
  context.fillText('EasyField', pagePadding + 65, 94)
  context.font = font.meta
  context.fillStyle = COLOR.pink
  context.fillText('STORYBOARD', pagePadding + 188, 95)
  context.textAlign = 'right'
  context.fillStyle = COLOR.inkMuted
  const aspectLabel = cleanText(aspect) || '16:9'
  context.fillText(
    `${includeTiming ? `${formatStoryboardDuration(totalDurationSeconds).toUpperCase()}  ·  ` : ''}${sceneCount} ${sceneCount === 1 ? 'SCENE' : 'SCENES'}  ·  ${aspectLabel}`,
    CANVAS_WIDTH - pagePadding,
    95,
  )
  context.restore()

  drawBlock(
    context,
    layout.title,
    pagePadding,
    layout.titleY,
    contentWidth,
    font.pageTitle,
    lineHeight.pageTitle,
    COLOR.ink,
  )

  const panelGradient = context.createLinearGradient(
    pagePadding,
    layout.storyPanelY,
    CANVAS_WIDTH - pagePadding,
    layout.storyPanelY + layout.storyPanelHeight,
  )
  panelGradient.addColorStop(0, 'rgba(111, 149, 255, 0.075)')
  panelGradient.addColorStop(0.5, 'rgba(21, 21, 29, 0.96)')
  panelGradient.addColorStop(1, 'rgba(238, 116, 215, 0.055)')
  fillRoundedRect(
    context,
    pagePadding,
    layout.storyPanelY,
    contentWidth,
    layout.storyPanelHeight,
    24,
    panelGradient,
  )
  strokeRoundedRect(
    context,
    pagePadding,
    layout.storyPanelY,
    contentWidth,
    layout.storyPanelHeight,
    24,
    COLOR.lineBright,
  )

  const labelY = layout.storyPanelY + spacing.storyTopPadding
  drawLabel(context, 'FULL STORY', pagePadding + storyHorizontalPadding, labelY, profile, COLOR.pink)
  drawBlock(
    context,
    layout.story,
    pagePadding + storyHorizontalPadding,
    labelY + lineHeight.label + spacing.storyLabelGap,
    contentWidth - storyHorizontalPadding * 2,
    font.story,
    lineHeight.story,
    COLOR.inkSoft,
  )
}

function drawSceneCard(
  context: CanvasRenderingContext2D,
  layout: SceneLayout,
  profile: TypographyProfile,
): void {
  const { spacing, font, lineHeight } = profile
  const cardRadius = profile.name === 'dense' ? 18 : profile.name === 'compact' ? 22 : 24
  const frameRadius = profile.name === 'dense' ? 12 : profile.name === 'compact' ? 14 : 16
  const cardGradient = context.createLinearGradient(layout.x, layout.y, layout.x + layout.width, layout.y + layout.height)
  cardGradient.addColorStop(0, 'rgba(26, 26, 36, 0.985)')
  cardGradient.addColorStop(1, 'rgba(14, 14, 20, 0.985)')
  fillRoundedRect(context, layout.x, layout.y, layout.width, layout.height, cardRadius, cardGradient)
  strokeRoundedRect(context, layout.x, layout.y, layout.width, layout.height, cardRadius, COLOR.line)

  const accentInset = Math.min(24, spacing.cardPadding)
  const accent = context.createLinearGradient(layout.x + accentInset, layout.y, layout.x + layout.width - accentInset, layout.y)
  accent.addColorStop(0, COLOR.blue)
  accent.addColorStop(0.55, COLOR.purple)
  accent.addColorStop(1, 'rgba(238, 116, 215, 0)')
  context.fillStyle = accent
  context.fillRect(layout.x + accentInset, layout.y, layout.width - accentInset * 2, 2)

  const badgeX = layout.x + spacing.cardPadding
  const badgeY = layout.y + spacing.cardPadding
  const badgeRadius = Math.max(10, Math.round(spacing.badgeSize * 0.28))
  fillRoundedRect(context, badgeX, badgeY, spacing.badgeSize, spacing.badgeSize, badgeRadius, 'rgba(168, 120, 255, 0.11)')
  strokeRoundedRect(context, badgeX, badgeY, spacing.badgeSize, spacing.badgeSize, badgeRadius, 'rgba(168, 120, 255, 0.34)')
  context.save()
  context.font = font.sceneNumber
  context.fillStyle = COLOR.ink
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(
    String(layout.scene.ordinal).padStart(2, '0'),
    badgeX + spacing.badgeSize / 2,
    badgeY + spacing.badgeSize / 2,
  )
  context.restore()

  drawBlock(
    context,
    layout.title,
    badgeX + spacing.badgeSize + spacing.badgeToTitle,
    badgeY + Math.max(0, (spacing.badgeSize - layout.title.height) / 2),
    layout.width - spacing.cardPadding * 2 - spacing.badgeSize - spacing.badgeToTitle,
    font.cardTitle,
    lineHeight.cardTitle,
    COLOR.ink,
  )

  fillRoundedRect(
    context,
    layout.frameX,
    layout.frameY,
    layout.frameWidth,
    layout.frameHeight,
    frameRadius,
    '#050508',
  )
  strokeRoundedRect(
    context,
    layout.frameX,
    layout.frameY,
    layout.frameWidth,
    layout.frameHeight,
    frameRadius,
    COLOR.lineBright,
  )

  const descriptionLabelY = layout.frameY + layout.frameHeight + spacing.frameToLabel
  drawLabel(context, 'SCENE DESCRIPTION', layout.x + spacing.cardPadding, descriptionLabelY, profile, COLOR.blue)
  const descriptionY = descriptionLabelY + lineHeight.label + spacing.labelToCopy
  drawBlock(
    context,
    layout.description,
    layout.x + spacing.cardPadding,
    descriptionY,
    layout.width - spacing.cardPadding * 2,
    font.description,
    lineHeight.description,
    COLOR.inkSoft,
  )

  const explanationLabelY = descriptionY + layout.description.height + spacing.sectionGap
  drawLabel(context, 'STORY PURPOSE', layout.x + spacing.cardPadding, explanationLabelY, profile, COLOR.amber)
  drawBlock(
    context,
    layout.explanation,
    layout.x + spacing.cardPadding,
    explanationLabelY + lineHeight.label + spacing.labelToCopy,
    layout.width - spacing.cardPadding * 2,
    font.explanation,
    lineHeight.explanation,
    COLOR.inkMuted,
  )
}

function drawContainedImage(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  layout: SceneLayout,
  profile: TypographyProfile,
): void {
  const frameRadius = profile.name === 'dense' ? 12 : profile.name === 'compact' ? 14 : 16
  const scale = Math.min(
    layout.frameWidth / image.naturalWidth,
    layout.frameHeight / image.naturalHeight,
  )
  const width = image.naturalWidth * scale
  const height = image.naturalHeight * scale
  const x = layout.frameX + (layout.frameWidth - width) / 2
  const y = layout.frameY + (layout.frameHeight - height) / 2

  context.save()
  roundedRect(
    context,
    layout.frameX,
    layout.frameY,
    layout.frameWidth,
    layout.frameHeight,
    frameRadius,
  )
  context.clip()
  context.fillStyle = '#050508'
  context.fillRect(layout.frameX, layout.frameY, layout.frameWidth, layout.frameHeight)
  context.drawImage(image, x, y, width, height)

  const shade = context.createLinearGradient(0, layout.frameY, 0, layout.frameY + layout.frameHeight)
  shade.addColorStop(0, 'rgba(0, 0, 0, 0.04)')
  shade.addColorStop(0.72, 'rgba(0, 0, 0, 0)')
  shade.addColorStop(1, 'rgba(0, 0, 0, 0.16)')
  context.fillStyle = shade
  context.fillRect(layout.frameX, layout.frameY, layout.frameWidth, layout.frameHeight)
  context.restore()

  strokeRoundedRect(
    context,
    layout.frameX,
    layout.frameY,
    layout.frameWidth,
    layout.frameHeight,
    frameRadius,
    COLOR.lineBright,
  )
}

function drawSceneTimingBadge(
  context: CanvasRenderingContext2D,
  layout: SceneLayout,
  profile: TypographyProfile,
): void {
  const label = `${formatStoryboardTimecode(layout.scene.startSeconds)}–${formatStoryboardTimecode(layout.scene.startSeconds + layout.scene.durationSeconds)}  ·  ${formatStoryboardDuration(layout.scene.durationSeconds)}`
  context.save()
  context.font = profile.font.meta
  const horizontalPadding = profile.name === 'dense' ? 10 : 13
  const height = profile.name === 'dense' ? 30 : 36
  const width = Math.ceil(context.measureText(label).width + horizontalPadding * 2)
  const x = layout.frameX + layout.frameWidth - width - 12
  const y = layout.frameY + 12
  fillRoundedRect(context, x, y, width, height, Math.round(height / 2), 'rgba(6, 6, 10, 0.82)')
  strokeRoundedRect(context, x, y, width, height, Math.round(height / 2), 'rgba(255, 255, 255, 0.18)')
  context.fillStyle = COLOR.ink
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(label, x + width / 2, y + height / 2 + 1)
  context.restore()
}

function drawFooter(
  context: CanvasRenderingContext2D,
  y: number,
  sceneCount: number,
  profile: TypographyProfile,
): void {
  const { spacing, font } = profile
  const contentWidth = CANVAS_WIDTH - spacing.pagePadding * 2
  const lineGradient = context.createLinearGradient(
    spacing.pagePadding,
    y,
    CANVAS_WIDTH - spacing.pagePadding,
    y,
  )
  lineGradient.addColorStop(0, 'rgba(111, 149, 255, 0)')
  lineGradient.addColorStop(0.22, 'rgba(111, 149, 255, 0.45)')
  lineGradient.addColorStop(0.55, 'rgba(168, 120, 255, 0.45)')
  lineGradient.addColorStop(0.82, 'rgba(238, 116, 215, 0.42)')
  lineGradient.addColorStop(1, 'rgba(238, 116, 215, 0)')
  context.fillStyle = lineGradient
  context.fillRect(spacing.pagePadding, y, contentWidth, 1)

  context.save()
  context.font = font.footer
  context.textBaseline = 'top'
  context.fillStyle = COLOR.inkFaint
  const footerTextOffset = profile.name === 'normal'
    ? 28
    : Math.min(26, Math.max(18, spacing.footerHeight * 0.34))
  const footerTextY = y + footerTextOffset
  context.fillText('EASYFIELD  ·  COMPLETE STORYBOARD', spacing.pagePadding, footerTextY)
  context.textAlign = 'right'
  context.fillText(
    `${sceneCount} ${sceneCount === 1 ? 'SCENE' : 'SCENES'}`,
    CANVAS_WIDTH - spacing.pagePadding,
    footerTextY,
  )
  context.restore()
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('The browser could not encode the storyboard as a PNG.'))
      }, 'image/png')
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : ''
      reject(new Error(`The storyboard PNG could not be created.${detail}`))
    }
  })
}

interface MeasuredBoard {
  profile: TypographyProfile
  header: HeaderLayout
  sceneLayout: { layouts: SceneLayout[]; bottom: number }
  footerY: number
  canvasHeight: number
}

function measureBoard(
  context: CanvasRenderingContext2D,
  title: string,
  story: string,
  scenes: StoryboardExportScene[],
  profile: TypographyProfile,
): MeasuredBoard {
  const header = measureHeader(context, title, story, profile)
  const sceneLayout = buildSceneLayouts(context, scenes, header.bottom, profile)
  const footerY = sceneLayout.bottom + profile.spacing.footerGap
  const canvasHeight = Math.ceil(footerY + profile.spacing.footerHeight)

  return {
    profile,
    header,
    sceneLayout,
    footerY,
    canvasHeight,
  }
}

/**
 * Renders a complete, ordered storyboard into one derived high-resolution PNG.
 * Source frames are read only and are never resized, rewritten or replaced.
 */
export async function renderStoryboardPng(input: StoryboardExportInput): Promise<Blob> {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    throw new Error('Storyboard PNG export is only available in the EasyField desktop interface.')
  }
  if (!Array.isArray(input.scenes) || input.scenes.length === 0) {
    throw new Error('Add at least one completed scene before exporting a storyboard.')
  }
  if (input.scenes.length > MAX_SCENES) {
    throw new Error(`A single storyboard PNG can contain at most ${MAX_SCENES} scenes.`)
  }

  const includeTiming = input.timingMode !== 'none'
  const totalDurationSeconds = Math.round(input.totalDurationSeconds)
  if (includeTiming && (!Number.isFinite(totalDurationSeconds) || totalDurationSeconds < input.scenes.length)) {
    throw new Error('The storyboard needs a valid total duration before export.')
  }

  const orderedScenes = input.scenes
    .map((scene, index) => ({ scene, index }))
    .sort((left, right) => left.scene.ordinal - right.scene.ordinal || left.index - right.index)
    .map(({ scene }) => scene)

  let timingCursor = 0
  const scenes = orderedScenes.map((scene) => {
    if (!Number.isFinite(scene.ordinal)) {
      throw new Error('Every storyboard scene needs a valid ordinal before export.')
    }
    const durationSeconds = Math.round(scene.durationSeconds)
    if (includeTiming && (!Number.isFinite(durationSeconds) || durationSeconds < 1)) {
      throw new Error(`Storyboard scene ${scene.ordinal} needs a valid duration before export.`)
    }
    const safeDuration = includeTiming ? durationSeconds : 1
    const timedScene = { ...scene, durationSeconds: safeDuration, startSeconds: timingCursor }
    if (includeTiming) timingCursor += safeDuration
    return timedScene
  })
  if (includeTiming && timingCursor !== totalDurationSeconds) {
    throw new Error('Scene durations must equal the total storyboard duration before export.')
  }

  await waitForProductFonts()

  const measuringCanvas = document.createElement('canvas')
  measuringCanvas.width = 1
  measuringCanvas.height = 1
  const measuringContext = measuringCanvas.getContext('2d')
  if (!measuringContext) throw new Error('This browser does not support storyboard canvas export.')

  const cleanTitle = normalizeLayoutText(input.title)
  const cleanStory = normalizeLayoutText(input.story)
  const attempts = TYPOGRAPHY_PROFILES.map((profile) => measureBoard(
    measuringContext,
    cleanTitle,
    cleanStory,
    scenes,
    profile,
  ))
  const board = attempts.find((attempt) => attempt.canvasHeight <= attempt.profile.safeHeight)

  if (!board) {
    const requiredHeight = attempts.at(-1)?.canvasHeight ?? CHROME_SAFE_CANVAS_HEIGHT + 1
    throw new Error(
      `This storyboard needs ${requiredHeight}px even in the densest complete layout, above the browser's safe ${CHROME_SAFE_CANVAS_HEIGHT}px single-image limit.`,
    )
  }

  const { profile, header, sceneLayout, footerY, canvasHeight } = board

  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_WIDTH
  canvas.height = canvasHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser does not support storyboard canvas export.')

  drawBackground(context, canvasHeight)
  drawHeader(
    context,
    header,
    cleanText(input.aspect),
    scenes.length,
    totalDurationSeconds,
    includeTiming,
    profile,
  )
  sceneLayout.layouts.forEach((layout) => drawSceneCard(context, layout, profile))

  // Load one frame at a time to keep decoded image memory bounded for a
  // 20-scene, high-resolution storyboard.
  for (const layout of sceneLayout.layouts) {
    const image = await loadSceneImage(layout.scene)
    drawContainedImage(context, image, layout, profile)
    if (includeTiming) drawSceneTimingBadge(context, layout, profile)
  }

  drawFooter(context, footerY, scenes.length, profile)
  return canvasToPng(canvas)
}
