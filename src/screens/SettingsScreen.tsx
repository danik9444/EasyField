import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react'
import type { Settings } from '../settings'
import { ACCENT_OPTIONS, SECURE_API_KEY_TOKEN } from '../settings'
import { resolve } from '../services/resolve'
import { host, type PluginUpdateStatus } from '../services/host'
import { Dropdown, type DropdownOptionMeta } from '../components/Dropdown'

type SettingsSection = 'general' | 'ai' | 'resolve' | 'storage' | 'privacy' | 'shortcuts' | 'diagnostics'

interface SettingsScreenProps {
  settings: Settings
  apiStatus: 'idle' | 'connecting' | 'connected' | 'error'
  apiError: string
  credits: number
  onBack: () => void
  onChange: (patch: Partial<Settings>) => void
  onConnectApiKey: (key: string) => void | Promise<void>
  onRefreshApiConnection: () => void | Promise<void>
  updateStatus: PluginUpdateStatus | null
  updateChecking: boolean
  updateInstalling: boolean
  updateInstalled: boolean
  updateError: string
  onCheckForUpdates: () => void | Promise<void>
  onInstallUpdate: () => void | Promise<void>
}

const SECTIONS: Array<{
  id: SettingsSection
  label: string
  icon: string
  eyebrow: string
  title: string
  description: string
  navDetail: string
}> = [
  { id: 'general', label: 'General', icon: '◫', eyebrow: 'WORKSPACE', title: 'Shape the workspace', description: 'Tune EasyField to the way you edit. Every preference follows you between Compact and Expanded views.', navDetail: 'Look & window' },
  { id: 'ai', label: 'AI & Models', icon: '✦', eyebrow: 'PROVIDERS', title: 'Models and intelligence', description: 'Connect cloud generation and manage local model packs without exposing credentials to the interface.', navDetail: 'Cloud & local' },
  { id: 'resolve', label: 'Resolve', icon: '◉', eyebrow: 'TIMELINE', title: 'Resolve connection', description: 'Control how reviewed results move into DaVinci Resolve while keeping timeline operations predictable.', navDetail: 'Bridge & placement' },
  { id: 'storage', label: 'Storage', icon: '▤', eyebrow: 'ARTIFACTS', title: 'Project storage', description: 'Choose where durable originals, working copies and project manifests live on this Mac.', navDetail: 'Files & retention' },
  { id: 'privacy', label: 'Privacy', icon: '◌', eyebrow: 'CONTROL', title: 'Privacy and budgets', description: 'Set the boundaries EasyField must respect before media leaves this Mac or paid work begins.', navDetail: 'Consent & spend' },
  { id: 'shortcuts', label: 'Shortcuts', icon: '⌘', eyebrow: 'KEYBOARD', title: 'Move without the mouse', description: 'Keep the most common navigation and planning actions available from every workspace.', navDetail: 'Global commands' },
  { id: 'diagnostics', label: 'Diagnostics', icon: '···', eyebrow: 'SYSTEM', title: 'System health', description: 'Review the local runtime, provider and Resolve bridge without exposing project content.', navDetail: 'Runtime checks' },
]

const PLACEMENT_OPTIONS: Array<{ value: Settings['placementMode']; label: string; meta: DropdownOptionMeta }> = [
  { value: 'playhead', label: 'Place at playhead', meta: { group: 'Non-destructive', badge: 'DEFAULT', description: 'Use the next free managed EasyField track.' } },
  { value: 'append', label: 'Append to timeline', meta: { group: 'Non-destructive', description: 'Add after existing timeline content.' } },
  { value: 'media-pool', label: 'Media Pool only', meta: { group: 'Import only', description: 'Import the artifact without changing the timeline.' } },
  { value: 'replace', label: 'Replace selection', meta: { group: 'Requires review', badge: 'PLANNED', disabled: true, disabledReason: 'Requires the Timeline Preview adapter; unavailable in this build.' } },
]
const PLACEMENT_META = Object.fromEntries(PLACEMENT_OPTIONS.map((option) => [option.label, option.meta]))
const IMPLEMENTED_ARTIFACT_ROOT = '~/Movies/EasyField'

export function SettingsScreen({ settings, apiStatus, apiError, credits, onBack, onChange, onConnectApiKey, onRefreshApiConnection, updateStatus, updateChecking, updateInstalling, updateInstalled, updateError, onCheckForUpdates, onInstallUpdate }: SettingsScreenProps) {
  const [section, setSection] = useState<SettingsSection>('general')
  const [keyDraft, setKeyDraft] = useState(() => settings.apiKey === SECURE_API_KEY_TOKEN ? '' : settings.apiKey)
  const [checking, setChecking] = useState(false)
  const bridge = useSyncExternalStore(resolve.subscribe, resolve.getStatus)
  const storedSecureKey = settings.apiKey === SECURE_API_KEY_TOKEN
  const keyToValidate = keyDraft.trim() || (storedSecureKey ? SECURE_API_KEY_TOKEN : '')
  const canValidateKey = Boolean(keyToValidate) && apiStatus !== 'connecting'

  useEffect(() => setKeyDraft(settings.apiKey === SECURE_API_KEY_TOKEN ? '' : settings.apiKey), [settings.apiKey])
  useEffect(() => { void resolve.refreshStatus() }, [])

  const diagnostics = useMemo(() => [
    { label: 'Runtime', value: host.isPlugin() ? 'Electron plugin' : 'Browser development', ok: true },
    { label: 'EasyField version', value: updateStatus?.currentVersion ?? (host.isPlugin() ? 'Checking…' : 'Development build'), ok: updateStatus?.supported !== false && !updateStatus?.available && !updateError },
    { label: 'DaVinci Resolve', value: bridge.connected ? `${bridge.product ?? 'Resolve'} · ${bridge.timeline ?? 'Timeline'}` : bridge.compatibilityError ?? 'Disconnected', ok: bridge.connected },
    { label: 'EasyField Cloud', value: apiStatus === 'connected' ? `${credits.toLocaleString()} credits` : apiStatus === 'error' ? apiError : 'Disconnected', ok: apiStatus === 'connected' },
    { label: 'Persistent state', value: host.isPlugin() ? 'SQLite · WAL' : 'Browser fallback', ok: true },
    { label: 'Credentials', value: host.isPlugin() ? 'macOS safeStorage' : 'Session only', ok: host.isPlugin() },
  ], [apiError, apiStatus, bridge, credits, updateError, updateStatus])
  const activeSection = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0]
  const diagnosticHealth = diagnostics.filter((item) => item.ok).length
  const sectionStatus = section === 'ai'
    ? { label: apiStatus === 'connected' ? `${credits.toLocaleString()} credits` : apiStatus === 'connecting' ? 'Checking connection' : 'Connection needed', tone: apiStatus === 'connected' ? 'is-ok' : 'is-warning' }
    : section === 'resolve'
      ? { label: updateStatus?.available ? 'EasyField update available' : bridge.connected ? 'Resolve connected' : bridge.compatibilityError ? 'Update required' : 'Resolve offline', tone: bridge.connected && !updateStatus?.available ? 'is-ok' : 'is-warning' }
      : section === 'privacy'
        ? { label: 'No EasyField spend cap', tone: 'is-neutral' }
        : section === 'diagnostics'
          ? { label: `${diagnosticHealth}/${diagnostics.length} checks healthy`, tone: diagnosticHealth === diagnostics.length ? 'is-ok' : 'is-warning' }
          : section === 'shortcuts'
            ? { label: '4 global shortcuts', tone: 'is-neutral' }
            : section === 'storage'
              ? { label: 'Durable local storage', tone: 'is-ok' }
              : { label: 'Saved locally', tone: 'is-ok' }

  const checkResolveConnection = async () => {
    setChecking(true)
    try { await resolve.refreshStatus() } finally { setChecking(false) }
  }

  const runDiagnostics = async () => {
    setChecking(true)
    try {
      await Promise.allSettled([
        resolve.refreshStatus(),
        settings.apiKey.trim() ? Promise.resolve(onRefreshApiConnection()) : Promise.resolve(),
      ])
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="ef-screen ef-settings-screen">
      <header className="ef-workspace-header">
        <button type="button" className="ef-back-btn" onClick={onBack} aria-label="Back">←</button>
        <span className="ef-workspace-heading"><small>EASYFIELD</small><strong>Settings</strong></span>
      </header>
      <div className="ef-settings-layout">
        <nav className="ef-settings-nav" aria-label="Settings sections">
          <div className="ef-settings-nav-brand" aria-hidden="true">
            <small>PREFERENCES</small>
            <strong>Project-safe defaults</strong>
          </div>
          <div className="ef-settings-nav-items">
            {SECTIONS.map((item, index) => (
              <button
                type="button"
                aria-current={section === item.id ? 'page' : undefined}
                className={section === item.id ? 'is-active' : ''}
                key={item.id}
                onClick={() => setSection(item.id)}
                onKeyDown={(event) => {
                  if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
                  event.preventDefault()
                  const buttons = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button') ?? [])
                  const compactGrid = window.matchMedia('(max-width: 699px)').matches
                  const direction = compactGrid && event.key === 'ArrowDown'
                    ? 4
                    : compactGrid && event.key === 'ArrowUp'
                      ? -4
                      : event.key === 'ArrowDown' || event.key === 'ArrowRight'
                        ? 1
                        : -1
                  const nextIndex = event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? buttons.length - 1
                      : compactGrid && (event.key === 'ArrowDown' || event.key === 'ArrowUp')
                        ? Math.min(buttons.length - 1, Math.max(0, index + direction))
                        : (index + direction + buttons.length) % buttons.length
                  buttons[nextIndex]?.focus()
                }}
              >
                <span className="ef-settings-nav-icon" aria-hidden="true">{item.icon}</span>
                <span className="ef-settings-nav-copy"><strong>{item.label}</strong><small>{item.navDetail}</small></span>
              </button>
            ))}
          </div>
          <div className="ef-settings-nav-note">
            <i aria-hidden="true" />
            <span>Changes save automatically<small>Local to this Mac</small></span>
          </div>
        </nav>
        <main className="ef-settings-content ef-scroll">
          <header className="ef-settings-section-head">
            <div>
              <small>{activeSection.eyebrow}</small>
              <h1>{activeSection.title}</h1>
              <p>{activeSection.description}</p>
            </div>
            <span className={`ef-settings-section-status ${sectionStatus.tone}`}><i aria-hidden="true" />{sectionStatus.label}</span>
          </header>
          {section === 'general' && (
            <SettingsGroup title="Appearance" description="The same controls are available in Compact and Expanded mode.">
              <SettingRow label="Window mode" hint="One adaptive window; state never resets when resizing.">
                <div className="ef-setting-segmented">
                  {(['compact', 'expanded'] as const).map((mode) => <button type="button" aria-pressed={settings.windowMode === mode} className={settings.windowMode === mode ? 'is-selected' : ''} key={mode} onClick={() => onChange({ windowMode: mode })}>{mode}</button>)}
                </div>
              </SettingRow>
              <SettingRow label="Accent" hint="Category colors stay semantic; this controls the personal accent.">
                <div className="ef-accent-options">{ACCENT_OPTIONS.map((color) => <button type="button" key={color} aria-pressed={settings.accent === color} className={settings.accent === color ? 'is-selected' : ''} style={{ background: color }} aria-label={`Use ${color} accent`} onClick={() => onChange({ accent: color })} />)}</div>
              </SettingRow>
              <SettingRow label="Ambient glow" hint="Respects Reduce Motion and remains decorative."><Toggle label="Ambient glow" checked={settings.glow} onChange={(glow) => onChange({ glow })} /></SettingRow>
            </SettingsGroup>
          )}

          {section === 'ai' && (
            <>
              <SettingsGroup title="EasyField Cloud" description="The API key is encrypted by macOS and is never written to localStorage.">
                <form
                  className="ef-settings-api-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (canValidateKey) void onConnectApiKey(keyToValidate)
                  }}
                >
                  <label className="ef-setting-field" htmlFor="ef-settings-api-key">
                    <span>API key</span>
                    <input
                      id="ef-settings-api-key"
                      type="password"
                      value={keyDraft}
                      autoComplete="off"
                      spellCheck={false}
                      aria-describedby="ef-settings-api-status"
                      aria-invalid={apiStatus === 'error'}
                      placeholder={storedSecureKey ? 'Stored securely in macOS Keychain' : 'Paste your EasyField Cloud API key'}
                      onChange={(event) => setKeyDraft(event.target.value)}
                    />
                  </label>
                  <button
                    type="submit"
                    className="ef-setting-primary"
                    disabled={!canValidateKey}
                    title={!keyToValidate ? 'Enter an API key first' : undefined}
                  >
                    {apiStatus === 'connecting' ? 'Checking…' : apiStatus === 'connected' ? 'Validate again' : 'Connect securely'}
                  </button>
                  <p id="ef-settings-api-status" role="status" aria-live="polite" className={`ef-setting-status is-${apiStatus}`}>{apiStatus === 'connected' ? `Connected · ${credits.toLocaleString()} credits` : apiStatus === 'error' ? apiError : !keyToValidate ? 'Enter an API key to enable cloud actions.' : 'The key stays on this Mac.'}</p>
                </form>
              </SettingsGroup>
              <SettingsGroup title="Local model packs" description="Whisper and analysis packs install on first use after showing download size and free space.">
                <SettingRow label="Transcription engine" hint="The approved product behavior asks on every run."><span className="ef-setting-value">Ask every run</span></SettingRow>
                <SettingRow label="Voice clone" hint="Provider-neutral contract exists; execution stays hidden until a provider is approved."><span className="ef-setting-value is-muted">Not enabled in beta</span></SettingRow>
              </SettingsGroup>
            </>
          )}

          {section === 'resolve' && (
            <>
              <SettingsGroup title="DaVinci Resolve 20+" description="Generation remains available while Resolve is disconnected; Apply actions do not.">
                <SettingRow label="Connection" hint={bridge.connected ? `${bridge.project ?? 'Project'} · ${bridge.timeline ?? 'Timeline'}` : bridge.compatibilityError ?? 'Open EasyField from Workspace › Workflow Integrations.'}><span className={`ef-connection-state ${bridge.connected ? 'is-connected' : ''}`}>{bridge.connected ? 'Connected' : bridge.compatibilityError ? 'Update required' : 'Disconnected'}</span></SettingRow>
                <SettingRow label="Default placement" hint="No ripple. A free managed EasyField track is used.">
                  <Dropdown
                    options={PLACEMENT_OPTIONS.map((option) => option.label)}
                    selected={PLACEMENT_OPTIONS.find((option) => option.value === settings.placementMode)?.label ?? PLACEMENT_OPTIONS[0].label}
                    onSelect={(label) => {
                      const placementMode = PLACEMENT_OPTIONS.find((option) => option.label === label)?.value
                      if (placementMode) onChange({ placementMode })
                    }}
                    label="Default placement"
                    align="left"
                    variant="field"
                    optionMeta={PLACEMENT_META}
                    searchable={false}
                  />
                </SettingRow>
                <button type="button" className="ef-setting-primary" onClick={() => void checkResolveConnection()} disabled={checking}>{checking ? 'Checking…' : 'Check connection'}</button>
              </SettingsGroup>
              <SettingsGroup title="EasyField updates" description="EasyField checks your latest local release automatically. Installing replaces only the integration; settings and Library stay untouched.">
                <SettingRow
                  label="Installed version"
                  hint={updateInstalled
                    ? 'Update installed. Restart DaVinci Resolve to load it.'
                    : updateError
                      ? updateError
                      : updateStatus?.available
                        ? `Version ${updateStatus.candidateVersion ?? 'new build'} is ready to install.`
                        : updateStatus?.supported
                          ? `Up to date · checked ${new Date(updateStatus.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                          : updateStatus?.reason ?? 'Check for the latest EasyField integration.'}
                >
                  <span className={`ef-connection-state ${updateStatus?.supported !== false && !updateStatus?.available && !updateError ? 'is-connected' : ''}`}>
                    {updateStatus?.currentVersion ?? (host.isPlugin() ? 'Checking…' : 'Development')}
                  </span>
                </SettingRow>
                <button
                  type="button"
                  className="ef-setting-primary"
                  onClick={() => void (updateStatus?.available ? onInstallUpdate() : onCheckForUpdates())}
                  disabled={updateChecking || updateInstalling || updateInstalled || (!host.isPlugin() && updateStatus?.supported === false)}
                >
                  {updateInstalling
                    ? 'Installing…'
                    : updateInstalled
                      ? 'Restart Resolve to finish'
                      : updateChecking
                        ? 'Checking…'
                        : updateStatus?.available
                          ? `Update to ${updateStatus.candidateVersion ?? 'new build'}`
                          : host.isPlugin()
                            ? 'Check for updates'
                            : 'Open inside Resolve to update'}
                </button>
                {updateError && <p className="ef-setting-update-error" role="alert">{updateError}</p>}
              </SettingsGroup>
            </>
          )}

          {section === 'storage' && (
            <SettingsGroup title="Local artifacts" description="Provider originals and Resolve-compatible working copies stay together with the project manifest.">
              <label className="ef-setting-field">
                <span>Active storage root</span>
                <input aria-label="Active artifact root" value={IMPLEMENTED_ARTIFACT_ROOT} readOnly aria-readonly="true" />
                <small className="ef-setting-help" role="status">Custom roots are not active in this build. EasyField will not pretend a typed path changed where artifacts are written.</small>
              </label>
              <SettingRow label="Retention" hint="Used assets are never removed automatically."><span className="ef-setting-value">Suggest preview cleanup after 30 days</span></SettingRow>
              <SettingRow label="Project identity" hint="Duplicate project names never share a workspace."><span className="ef-setting-value">Name + immutable short ID</span></SettingRow>
            </SettingsGroup>
          )}

          {section === 'privacy' && (
            <SettingsGroup title="Privacy and cost" description="Every cloud run shows its price and upload manifest without imposing an EasyField generation cap.">
              <SettingRow label="Cloud consent" hint="Consent is remembered separately for image, video, audio and transcript."><span className="ef-setting-value">First use + manifest every run</span></SettingRow>
              <SettingRow label="Generation limit" hint="EasyField shows live pricing but never blocks a run because of a local credit ceiling."><span className="ef-setting-value">Unlimited</span></SettingRow>
              <SettingRow label="Technical telemetry" hint="Never includes prompts, media, project content or credentials."><Toggle label="Technical telemetry" checked={settings.telemetry} onChange={(telemetry) => onChange({ telemetry })} /></SettingRow>
            </SettingsGroup>
          )}

          {section === 'shortcuts' && (
            <SettingsGroup title="Keyboard shortcuts" description="Shortcuts remain available in every workspace unless a text field is active.">
              {[['Command Bar / SuperBrain', '⌘ K'], ['Search tools', '⌘ F'], ['Back', '⌘ ['], ['Close overlay', 'Esc']].map(([label, shortcut]) => <SettingRow key={label} label={label}><kbd>{shortcut}</kbd></SettingRow>)}
            </SettingsGroup>
          )}

          {section === 'diagnostics' && (
            <SettingsGroup title="Diagnostics" description="This report contains technical state only and does not include media or prompts.">
              <div className="ef-diagnostics-list">{diagnostics.map((item) => <div key={item.label}><i className={item.ok ? 'is-ok' : ''} /><span><strong>{item.label}</strong><small>{item.value}</small></span></div>)}</div>
              <button type="button" className="ef-setting-primary" onClick={() => void runDiagnostics()} disabled={checking || apiStatus === 'connecting'}>{checking ? 'Running checks…' : 'Run checks again'}</button>
            </SettingsGroup>
          )}
        </main>
      </div>
    </div>
  )
}

function SettingsGroup({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <section className="ef-settings-group"><header><h2>{title}</h2><p>{description}</p></header>{children}</section>
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  const labelId = useId()
  return <div className="ef-setting-row" role="group" aria-labelledby={labelId}><span><strong id={labelId}>{label}</strong>{hint && <small>{hint}</small>}</span><div>{children}</div></div>
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <button type="button" role="switch" aria-label={label} aria-checked={checked} className={'ef-toggle' + (checked ? ' is-on' : '')} onClick={() => onChange(!checked)}><span /></button>
}
