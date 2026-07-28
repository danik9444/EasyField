import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Icon } from '../icons'
import { CATALOG } from '../data/catalog'
import { TOOL_BY_ID } from '../data/toolDefinitions'
import { formatTokens } from '../data/usage'
import { useCreations } from '../data/creations'
import { resolve } from '../services/resolve'
import { SECURE_API_KEY_TOKEN, type Settings } from '../settings'
import type { ToolId } from '../core/contracts'

const MEDIA_CATEGORY_COPY: Record<string, { eyebrow: string; description: string }> = {
  footage: { eyebrow: 'ORGANIZE & ENHANCE MEDIA', description: 'Review selects, find coverage and improve source quality.' },
  image: { eyebrow: 'CREATE & REFINE STILLS', description: 'Generate, edit and keep visual references consistent.' },
  video: { eyebrow: 'GENERATE & EDIT SHOTS', description: 'Create, transform, extend and bridge moving shots.' },
  motion: { eyebrow: 'TITLES & GRAPHICS', description: 'Build motion graphics, animation and editable captions.' },
  audio: { eyebrow: 'SOUND & TIMING', description: 'Generate sound, narration, transcripts and editorial timing.' },
}

// Home cards deliberately use the short editorial copy from the original
// compact panel. The full definitions stay detailed everywhere else (search,
// workspace introductions and accessibility), while this directory remains
// fast to scan at Resolve-panel width.
const HOME_TOOL_DESCRIPTIONS: Partial<Record<ToolId, string>> = {
  culling: 'Sort raw footage',
  broll: 'Auto-match b-roll',
  upscale: 'Enhance up to 4K',
  'create-image': 'Text to still frame',
  storyboard: 'Script to frames',
  character: 'Consistent identity',
  'edit-image': 'Inpaint & retouch',
  angles: 'New camera angles',
  'create-video': 'Text/image to clip',
  avatar: 'Talking presenter',
  'edit-video': 'Prompt-based edits',
  extend: 'Continue any shot',
  transition: 'Generative morphs',
  animations: 'AI motion graphics',
  captions: 'Styled subtitles',
  music: 'Score to your cut',
  sfx: 'Foley on demand',
  vo: 'Line-based narration',
  transcribe: 'Speech to text',
  beat: 'Cut markers on beat',
}

const HOME_WORKSPACES = CATALOG.map((category) => ({
  id: category.id,
  label: category.label,
  eyebrow: MEDIA_CATEGORY_COPY[category.id].eyebrow,
  description: MEDIA_CATEGORY_COPY[category.id].description,
  color: category.color,
  tools: category.tools.map((tool) => ({
    ...tool,
    homeDesc: HOME_TOOL_DESCRIPTIONS[tool.id] ?? tool.desc,
    media: category.label,
    mediaColor: category.color,
    mediaTint: category.tint,
  })),
}))

const HOME_TOOL_COUNT = HOME_WORKSPACES.reduce((total, workspace) => total + workspace.tools.length, 0)
const HOME_CATEGORY_IDS = ['all', ...HOME_WORKSPACES.map((workspace) => workspace.id)]

interface HomeProps {
  settings: Settings
  credits: number
  creditsLive: boolean
  apiStatus: 'idle' | 'connecting' | 'connected' | 'error'
  apiError: string
  onConnectApiKey: (key: string) => void
  onOpenCreate: () => void
  onOpenCharacter: () => void
  onOpenCreateVideo: () => void
  onOpenEditImage: () => void
  onOpenEditVideo: () => void
  onOpenCreateMusic: () => void
  onOpenSoundEffects: () => void
  onOpenVoiceOver: () => void
  onOpenAnimation: () => void
  onOpenBrain: () => void
  onOpenLibrary: () => void
  onOpenSettings: () => void
  onOpenTool: (toolId: ToolId) => void
  onToggleWindowMode: () => void
  onToggleWindowHeight: () => void
  windowMode: 'compact' | 'expanded'
  windowHeightMode: 'standard' | 'full'
  toast: (msg: string) => void
  searchFocusSignal: number
}

export function Home({
  settings,
  credits,
  creditsLive,
  apiStatus,
  apiError,
  onConnectApiKey,
  onOpenCreate,
  onOpenCharacter,
  onOpenCreateVideo,
  onOpenEditImage,
  onOpenEditVideo,
  onOpenCreateMusic,
  onOpenSoundEffects,
  onOpenVoiceOver,
  onOpenAnimation,
  onOpenBrain,
  onOpenLibrary,
  onOpenSettings,
  onOpenTool,
  onToggleWindowMode,
  onToggleWindowHeight,
  windowMode,
  windowHeightMode,
  searchFocusSignal,
}: HomeProps) {
  const [query, setQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState('all')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [keyDraft, setKeyDraft] = useState(() => settings.apiKey === SECURE_API_KEY_TOKEN ? '' : settings.apiKey)
  const searchRef = useRef<HTMLInputElement>(null)
  const keyInputRef = useRef<HTMLInputElement>(null)
  const settingsDialogRef = useRef<HTMLDivElement>(null)
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null)
  const creations = useCreations()
  // Live DaVinci bridge status — polls every 5s while this component is mounted.
  const bridge = useSyncExternalStore(resolve.subscribe, resolve.getStatus)

  const onCategoryKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const tablist = event.currentTarget.parentElement
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? HOME_CATEGORY_IDS.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + HOME_CATEGORY_IDS.length) % HOME_CATEGORY_IDS.length
    setActiveCategory(HOME_CATEGORY_IDS[nextIndex])
    requestAnimationFrame(() => tablist?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus())
  }

  useEffect(() => {
    if (searchFocusSignal <= 0) return
    const frame = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [searchFocusSignal])

  useEffect(() => {
    setKeyDraft(settings.apiKey === SECURE_API_KEY_TOKEN ? '' : settings.apiKey)
  }, [settings.apiKey])

  useEffect(() => {
    if (!settingsOpen) return
    keyInputRef.current?.focus()

    const keepFocusInSettings = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setSettingsOpen(false)
        requestAnimationFrame(() => settingsReturnFocusRef.current?.focus())
        return
      }
      if (event.key !== 'Tab') return

      const focusable = settingsDialogRef.current?.querySelectorAll<HTMLElement>(
        'input:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', keepFocusInSettings)
    return () => window.removeEventListener('keydown', keepFocusInSettings)
  }, [settingsOpen])

  // Warm the badge with a fresh read on mount (fire-and-forget).
  useEffect(() => {
    void resolve.refreshStatus()
  }, [])

  const searching = query.trim().length > 0
  const visibleGroups = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    const groups = activeCategory === 'all' ? HOME_WORKSPACES : HOME_WORKSPACES.filter((group) => group.id === activeCategory)
    if (!normalized) return groups

    return groups.map((group) => ({
      ...group,
      tools: group.tools.filter((tool) =>
        [tool.name, tool.desc, tool.media, group.label, group.eyebrow, group.description, TOOL_BY_ID[tool.id].workspace]
          .some((value) => value.toLocaleLowerCase().includes(normalized)),
      ),
    })).filter((group) => group.tools.length > 0)
  }, [activeCategory, query])
  const visibleToolCount = visibleGroups.reduce((count, group) => count + group.tools.length, 0)
  const storedSecureKey = settings.apiKey === SECURE_API_KEY_TOKEN
  const keyToValidate = keyDraft.trim() || (storedSecureKey ? SECURE_API_KEY_TOKEN : '')
  const canValidateKey = Boolean(keyToValidate) && apiStatus !== 'connecting'

  const openApiSettings = () => {
    settingsReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSettingsOpen(true)
  }

  const closeApiSettings = () => {
    setSettingsOpen(false)
    requestAnimationFrame(() => settingsReturnFocusRef.current?.focus())
  }

  const toggleApiSettings = () => {
    if (settingsOpen) closeApiSettings()
    else openApiSettings()
  }

  const openTool = (toolId: ToolId) => {
    if (toolId === 'create-image') onOpenCreate()
    else if (toolId === 'character') onOpenCharacter()
    else if (toolId === 'create-video') onOpenCreateVideo()
    else if (toolId === 'edit-image') onOpenEditImage()
    else if (toolId === 'edit-video') onOpenEditVideo()
    else if (toolId === 'music') onOpenCreateMusic()
    else if (toolId === 'sfx') onOpenSoundEffects()
    else if (toolId === 'vo') onOpenVoiceOver()
    else if (toolId === 'animations') onOpenAnimation()
    else onOpenTool(toolId as ToolId)
  }

  return (
    <div className="ef-screen ef-screen--home">
      {settings.glow && <div className="ef-glow" />}

      <header className="ef-home-header">
        <div className="ef-home-brand" aria-label="EasyField Pro">
          <span className="ef-logo-tile" aria-hidden="true">
            <Icon glyph="spark" color="#14060F" size={14} />
          </span>
          <span className="ef-wordmark">EasyField</span>
          <span className="ef-pro-badge">PRO</span>
        </div>
        <span className="ef-spacer" />
        <button
          type="button"
          className="ef-density-toggle"
          onClick={onToggleWindowMode}
          aria-label={`Switch to ${windowMode === 'compact' ? 'expanded' : 'compact'} view`}
          title={windowMode === 'compact' ? 'Expand workspace' : 'Compact workspace'}
        >
          {windowMode === 'compact' ? '↗' : '↙'}
        </button>
        <button
          type="button"
          className="ef-density-toggle"
          onClick={onToggleWindowHeight}
          aria-label={windowHeightMode === 'standard' ? 'Fill the available screen height' : 'Restore the standard window height'}
          title={windowHeightMode === 'standard' ? 'Full height' : 'Standard height'}
        >
          {windowHeightMode === 'standard' ? '↕' : '↥'}
        </button>
        <button type="button" className="ef-density-toggle" onClick={onOpenSettings} aria-label="Open settings" title="Settings">⚙</button>
        <div className="ef-home-statuses" aria-label="Connections and account">
          <span
            className={'ef-resolve-badge' + (bridge.connected ? ' live' : '')}
            role="status"
            aria-label={
              bridge.connected
                ? `Resolve connected to ${bridge.project ?? 'project'}, ${bridge.timeline ?? 'timeline'}`
                : bridge.compatibilityError ? 'Resolve integration update required' : 'Resolve is not connected'
            }
            title={
              bridge.connected
                ? `${bridge.project ?? 'Project'} · ${bridge.timeline ?? 'Timeline'}`
                : bridge.compatibilityError ?? 'Open EasyField inside DaVinci Resolve (Workspace ▸ Workflow Integrations)'
            }
          >
            <span className="ef-status-dot" aria-hidden="true">{bridge.connected ? '⦿' : '○'}</span>
            <span className="ef-resolve-badge-label">Resolve</span>
          </span>
          <button
            type="button"
            className={'ef-token-badge' + (creditsLive ? ' live' : '')}
            aria-label={creditsLive ? `${formatTokens(credits)} live credits. Open EasyField Cloud settings` : 'EasyField Cloud is not connected. Open settings'}
            aria-expanded={settingsOpen}
            aria-controls="ef-api-settings"
            title={creditsLive ? 'Live balance from your EasyField Cloud account' : 'Connect EasyField Cloud to see your live balance'}
            onClick={toggleApiSettings}
          >
            <span className="ef-token-badge-spark" aria-hidden="true">
              <Icon glyph="spark" size={10} />
            </span>
            <span className="ef-token-badge-value">{creditsLive ? formatTokens(credits) : 'Connect'}</span>
          </button>
        </div>
      </header>

      {settingsOpen && (
        <>
          <div className="ef-overlay" aria-hidden="true" onClick={closeApiSettings} />
          <div
            ref={settingsDialogRef}
            id="ef-api-settings"
            className="ef-settings"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ef-api-settings-title"
          >
            <div className="ef-settings-heading">
              <span className="ef-settings-label" id="ef-api-settings-title">CONNECT EASYFIELD CLOUD</span>
              <button type="button" className="ef-settings-close" aria-label="Close EasyField Cloud settings" onClick={closeApiSettings}>×</button>
            </div>
            <form
              className="ef-apikey-row"
              onSubmit={(event) => {
                event.preventDefault()
                if (canValidateKey) onConnectApiKey(keyToValidate)
              }}
            >
              <input
                ref={keyInputRef}
                className="ef-apikey-input"
                type="password"
                aria-label="EasyField Cloud API key"
                placeholder={storedSecureKey ? 'Stored securely in Keychain' : 'Paste your API key…'}
                value={keyDraft}
                autoComplete="off"
                spellCheck={false}
                aria-describedby="ef-home-api-status"
                aria-invalid={apiStatus === 'error'}
                onChange={(e) => setKeyDraft(e.target.value)}
              />
              <button
                type="submit"
                className="ef-apikey-btn"
                disabled={!canValidateKey}
                title={!keyToValidate ? 'Enter an API key first' : undefined}
              >
                {apiStatus === 'connecting' ? '…' : creditsLive ? 'Refresh' : 'Connect'}
              </button>
            </form>
            <div id="ef-home-api-status" className={'ef-apikey-status ' + apiStatus} role="status" aria-live="polite">
              {apiStatus === 'connected' && `✓ Connected · ${credits.toLocaleString()} credits`}
              {apiStatus === 'error' && `✕ ${apiError}`}
              {apiStatus === 'connecting' && 'Checking your balance…'}
              {apiStatus === 'idle' && (!keyToValidate ? 'Enter an API key to enable cloud actions.' : 'The key stays on this Mac.')}
            </div>
          </div>
        </>
      )}

      <button type="button" className="ef-library-entry" onClick={onOpenLibrary}>
        <span className="ef-library-entry-icon" aria-hidden="true">
          <Icon glyph="board" size={15} />
        </span>
        <span className="ef-library-entry-text">
          <span className="ef-library-entry-title">Library</span>
          <span className="ef-library-entry-sub">
            {creations.length ? `${creations.length} saved asset${creations.length === 1 ? '' : 's'} · timeline grabs & versions` : 'Local assets, timeline grabs and generated versions'}
          </span>
        </span>
        <span className="ef-spacer" />
        <span className="ef-library-entry-state">LOCAL</span>
        <span className="ef-library-entry-arrow">›</span>
      </button>

      <section className="ef-home-search-panel" aria-label="Find and filter tools">
        <div className="ef-search">
          <span className="ef-search-glyph" aria-hidden="true">
            <Icon glyph="mask" size={15} />
          </span>
          <input
            ref={searchRef}
            type="search"
            aria-label="Search all EasyField tools"
            aria-keyshortcuts="Meta+F Control+F"
            placeholder={`Search all ${HOME_TOOL_COUNT} tools…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {searching ? (
            <button
              type="button"
              className="ef-search-clear"
              aria-label="Clear tool search"
              onClick={() => {
                setQuery('')
                searchRef.current?.focus()
              }}
            >
              ×
            </button>
          ) : (
            <span className="ef-kbd" aria-hidden="true">⌘F</span>
          )}
        </div>
        <div className="ef-home-directory-intro">
          <h1>Choose your workspace</h1>
          <p>Start with your project media. Find the best tool to create, edit, analyze or finish.</p>
        </div>
        <div className="ef-category-tabs" role="tablist" aria-label="Filter tools by media type">
          <button type="button" role="tab" aria-selected={activeCategory === 'all'} tabIndex={activeCategory === 'all' ? 0 : -1} className={activeCategory === 'all' ? 'is-active' : ''} onKeyDown={(event) => onCategoryKeyDown(event, 0)} onClick={() => setActiveCategory('all')}>All <span>{HOME_TOOL_COUNT}</span></button>
          {HOME_WORKSPACES.map((group, index) => (
            <button
              type="button"
              role="tab"
              aria-selected={activeCategory === group.id}
              tabIndex={activeCategory === group.id ? 0 : -1}
              className={activeCategory === group.id ? 'is-active' : ''}
              style={{ '--ef-category-color': group.color } as CSSProperties}
              key={group.id}
              onKeyDown={(event) => onCategoryKeyDown(event, index + 1)}
              onClick={() => setActiveCategory(group.id)}
            >
              <i aria-hidden="true" /> {group.label} <span>{group.tools.length}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="ef-scroll ef-home-scroll">
        {searching && visibleToolCount > 0 && (
          <div className="ef-search-summary" role="status">
            {visibleToolCount === 1 ? '1 tool found' : `${visibleToolCount} tools found`}
          </div>
        )}
        {visibleGroups.length === 0 ? (
          <div className="ef-library-empty" role="status">
            No tools match “{query.trim()}”. Try image, video, audio, or motion.
          </div>
        ) : visibleGroups.map((group) => {
          const headingId = `ef-tool-group-${group.id}`
          return (
            <section
              className="ef-group"
              key={group.id}
              aria-labelledby={headingId}
              style={{ '--ef-category-color': group.color } as CSSProperties}
            >
              <div className="ef-group-header">
                <i className="ef-group-dot" aria-hidden="true" />
                <h2 className="ef-group-label" id={headingId}>{group.label}</h2>
                <span className="ef-group-rule" />
                <span className="ef-group-count">{String(group.tools.length).padStart(2, '0')}</span>
              </div>
              <div className="ef-tool-grid">
                {group.tools.map((tool, index) => (
                  <button
                    type="button"
                    className="ef-tool-card"
                    key={tool.id}
                    style={{ '--ef-category-color': group.color, '--ef-media-color': tool.mediaColor, '--ef-tool-order': index } as CSSProperties}
                    aria-label={`${tool.name}. ${tool.homeDesc}. ${tool.media} tool.`}
                    onClick={() => openTool(tool.id)}
                  >
                    <span className="ef-tool-tile" style={{ background: tool.mediaTint }} aria-hidden="true">
                      <Icon glyph={tool.glyph} color={tool.mediaColor} />
                    </span>
                    <span className="ef-tool-text">
                      <span className="ef-tool-name">{tool.name}</span>
                      <span className="ef-tool-desc">{tool.homeDesc}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )
        })}
      </div>

      <div className="ef-brain-bar-wrap ef-home-superbrain-wrap">
        <button type="button" className="ef-brain-bar ef-home-superbrain-bar" onClick={onOpenBrain} aria-label="Ask SuperBrain to do it for you">
          <span className="ef-brain-bar-spark" aria-hidden="true"><Icon glyph="spark" size={13} /></span>
          <span className="ef-brain-bar-label">Ask SuperBrain to do it for you</span>
          <span className="ef-spacer" />
          <span className="ef-brain-bar-kbd" aria-hidden="true">⌘K</span>
        </button>
      </div>
    </div>
  )
}
