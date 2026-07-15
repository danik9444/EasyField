import { useCallback, useEffect, useRef, useState } from 'react'
import { Home, type HomeNavigationMemory } from './screens/Home'
import { CreateImage } from './screens/CreateImage'
import { CreateVideo } from './screens/CreateVideo'
import { ExtendVideo } from './screens/ExtendVideo'
import { TransitionVideo } from './screens/TransitionVideo'
import { Storyboard } from './screens/Storyboard'
import { Angles } from './screens/Angles'
import { EditImage } from './screens/EditImage'
import { EditVideo } from './screens/EditVideo'
import { CreateMusic } from './screens/CreateMusic'
import { SoundEffects } from './screens/SoundEffects'
import { VoiceOver } from './screens/VoiceOver'
import { Animation } from './screens/Animation'
import { SuperBrain } from './screens/SuperBrain'
import { Library } from './screens/Library'
import {
  loadSettings,
  currentApiKey,
  sanitizeSettings,
  saveSettings,
  SECURE_API_KEY_TOKEN,
  CLOUD_API_CREDENTIAL,
  setCurrentApiKey,
  type Settings,
} from './settings'
import { loadCredits, saveCredits } from './data/usage'
import { fetchCredits, fetchModelPrices } from './services/providerGateway'
import { applyLivePrices } from './data/pricing'
import { JobCenter } from './components/JobCenter'
import { UpdateDialog } from './components/UpdateDialog'
import { hydrateJobs, recoverDurableJobs } from './services/jobCenter'
import { host, type PluginUpdateStatus } from './services/host'
import { ToolWorkspace } from './screens/ToolWorkspace'
import { BeatDetection } from './screens/BeatDetection'
import { Transcribe } from './screens/Transcribe'
import { Upscale } from './screens/Upscale'
import { Avatar } from './screens/Avatar'
import { SettingsScreen } from './screens/SettingsScreen'
import type { ToolId } from './core/contracts'

export type ApiStatus = 'idle' | 'connecting' | 'connected' | 'error'

type Screen = 'home' | 'create' | 'character' | 'create-video' | 'edit-image' | 'edit-video' | 'create-music' | 'sound-effects' | 'voice-over' | 'animation' | 'brain' | 'library' | 'workflow' | 'settings'

// A creation handed off from the Library to an Edit screen as its source clip.
export interface EditSource {
  kind: 'image' | 'video'
  url: string
  name?: string
}

const TOAST_MS = 1700

export default function App() {
  const [screen, setScreen] = useState<Screen>('home')
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [credits, setCredits] = useState<number>(loadCredits)
  const [apiCredits, setApiCredits] = useState<number | null>(null)
  const [apiStatus, setApiStatus] = useState<ApiStatus>('idle')
  const [apiError, setApiError] = useState<string>('')
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const [searchFocusSignal, setSearchFocusSignal] = useState(0)
  const [editSource, setEditSource] = useState<EditSource | null>(null)
  const [activeTool, setActiveTool] = useState<ToolId>('culling')
  const [updateStatus, setUpdateStatus] = useState<PluginUpdateStatus | null>(null)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateInstalling, setUpdateInstalling] = useState(false)
  const [updateInstalled, setUpdateInstalled] = useState(false)
  const [updateError, setUpdateError] = useState('')
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
  const [dismissedUpdateBuild, setDismissedUpdateBuild] = useState<string | null>(null)
  const [, setPricingRevision] = useState(0)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settingsHydratedRef = useRef(false)
  const screenRef = useRef<Screen>('home')
  const navigationHistoryRef = useRef<Screen[]>([])
  const homeNavigationMemoryRef = useRef<HomeNavigationMemory>({
    query: '',
    activeCategory: 'all',
    scrollTop: 0,
    windowMode: settings.windowMode,
    anchorToolId: null,
    anchorOffset: 0,
  })
  const updateCheckInFlightRef = useRef(false)

  const navigate = useCallback((next: Screen) => {
    const current = screenRef.current
    if (current === next) return
    navigationHistoryRef.current = [...navigationHistoryRef.current.slice(-29), current]
    screenRef.current = next
    setScreen(next)
  }, [])

  const goBack = useCallback(() => {
    const previous = navigationHistoryRef.current.pop() ?? 'home'
    screenRef.current = previous
    setScreen(previous)
  }, [])

  useEffect(() => {
    let active = true
    void host.getState<Partial<Settings>>('settings', 'current').then((persisted) => {
      if (!active) return
      if (persisted) setSettings((current) => sanitizeSettings({ ...persisted, apiKey: current.apiKey }, current))
      settingsHydratedRef.current = true
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    document.documentElement.style.setProperty('--ef-accent', settings.accent)
    saveSettings(settings)
    if (settingsHydratedRef.current) {
      const { apiKey: _secret, ...safeSettings } = settings
      void _secret
      void host.setState('settings', 'current', safeSettings)
    }
  }, [settings])

  // Keep the native Electron window in sync on boot as well as after a click.
  // Previously an expanded preference restored the CSS but left the actual
  // plugin window at its compact 400px width until the user toggled it twice.
  useEffect(() => {
    void host.setWindowMode(settings.windowMode)
  }, [settings.windowMode])

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
  }, [])

  useEffect(() => {
    void hydrateJobs()
  }, [])

  const checkForUpdates = useCallback(async (manual = true) => {
    if (updateCheckInFlightRef.current) return
    updateCheckInFlightRef.current = true
    setUpdateChecking(true)
    if (manual) setDismissedUpdateBuild(null)
    try {
      const status = await host.checkForUpdates()
      setUpdateStatus(status)
      setUpdateError('')
    } catch (error) {
      if (manual) setUpdateError(error instanceof Error ? error.message : 'EasyField could not check for updates.')
    } finally {
      updateCheckInFlightRef.current = false
      setUpdateChecking(false)
    }
  }, [])

  const installUpdate = useCallback(async () => {
    setUpdateDialogOpen(true)
    setUpdateInstalling(true)
    setUpdateError('')
    try {
      const result = await host.installUpdate()
      if (!result.installed) throw new Error('The update did not complete.')
      setUpdateInstalled(true)
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : 'EasyField could not install the update.')
    } finally {
      setUpdateInstalling(false)
    }
  }, [])

  // The installed Resolve integration checks its fixed, verified update source
  // quietly. A pending release waits until Activity or another modal closes.
  useEffect(() => {
    if (!host.isPlugin()) return
    const initial = window.setTimeout(() => void checkForUpdates(false), 1400)
    const interval = window.setInterval(() => void checkForUpdates(false), 5 * 60 * 1000)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(interval)
    }
  }, [checkForUpdates])

  useEffect(() => {
    const buildId = updateStatus?.candidateBuildId
    if (!updateStatus?.available || !buildId || buildId === dismissedUpdateBuild || updateDialogOpen || updateInstalled) return
    const showWhenFree = () => {
      if (!document.querySelector('[aria-modal="true"]')) setUpdateDialogOpen(true)
    }
    showWhenFree()
    const timer = window.setInterval(showWhenFree, 750)
    return () => window.clearInterval(timer)
  }, [dismissedUpdateBuild, updateDialogOpen, updateInstalled, updateStatus])

  const dismissUpdateDialog = useCallback(() => {
    if (updateInstalling) return
    if (!updateInstalled && updateStatus?.candidateBuildId) setDismissedUpdateBuild(updateStatus.candidateBuildId)
    setUpdateDialogOpen(false)
  }, [updateInstalled, updateInstalling, updateStatus])

  // Keep the public EasyField Cloud pricing table fresh. The feed needs no key;
  // a revision bump makes open workspaces immediately recompute their estimate.
  useEffect(() => {
    let active = true
    const refresh = async () => {
      const rows = await fetchModelPrices()
      if (!active || !rows.length) return
      applyLivePrices(rows)
      setPricingRevision((revision) => revision + 1)
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 15 * 60 * 1000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  const toast = useCallback((msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToastMsg(msg)
    toastTimer.current = setTimeout(() => setToastMsg(null), TOAST_MS)
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || !(e.metaKey || e.ctrlKey)) return
      const target = e.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return
      // A modal owns keyboard interaction until it is closed. This prevents a
      // global shortcut from replacing the screen behind Activity, a picker,
      // or a settings dialog while focus is inside that modal.
      if (document.querySelector('[aria-modal="true"]')) return
      const key = e.key.toLowerCase()
      if (key === 'k') {
        e.preventDefault()
        navigate('brain')
      } else if (key === 'f') {
        e.preventDefault()
        navigate('home')
        setSearchFocusSignal((n) => n + 1)
      } else if (key === '[') {
        e.preventDefault()
        goBack()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [goBack, navigate])

  const updateSettings = useCallback(
    (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })),
    [],
  )

  const toggleWindowMode = useCallback(() => {
    setSettings((current) => {
      const windowMode = current.windowMode === 'compact' ? 'expanded' : 'compact'
      return { ...current, windowMode }
    })
  }, [])

  const openToolWorkspace = useCallback((toolId: ToolId) => {
    setActiveTool(toolId)
    navigate('workflow')
  }, [navigate])

  // Read the live EasyField Cloud credit balance for the given key.
  const refreshCredits = useCallback(async (key: string) => {
    if (!key.trim()) {
      setApiCredits(null)
      setApiStatus('idle')
      setApiError('')
      return
    }
    setApiStatus('connecting')
    const r = await fetchCredits(key)
    if (r.ok) {
      setApiCredits(r.credits ?? 0)
      setApiStatus('connected')
      setApiError('')
    } else {
      setApiCredits(null)
      setApiStatus('error')
      setApiError(r.error ?? 'Failed to connect')
    }
  }, [])

  // Load the credential from Electron safeStorage. A legacy plaintext key is
  // migrated once, then saveSettings removes it from localStorage.
  const bootRef = useRef(false)
  useEffect(() => {
    if (bootRef.current) return
    bootRef.current = true
    void (async () => {
      const legacyKey = settings.apiKey.trim()
      const securedKey = await host.getCredential(CLOUD_API_CREDENTIAL)
      const key = securedKey || legacyKey
      if (legacyKey && !securedKey) await host.setCredential(CLOUD_API_CREDENTIAL, legacyKey)
      const runtimeKey = host.isPlugin() && key ? SECURE_API_KEY_TOKEN : key
      setCurrentApiKey(runtimeKey)
      setSettings((current) => ({ ...current, apiKey: runtimeKey }))
      if (runtimeKey) await refreshCredits(runtimeKey)
      if (runtimeKey) await recoverDurableJobs()
    })()
  }, [refreshCredits])

  const connectApiKey = useCallback(
    async (key: string) => {
      const candidate = key.trim()
      if (!candidate) {
        setApiCredits(null)
        setApiStatus('error')
        setApiError('Enter an EasyField Cloud API key to connect.')
        return
      }

      // Validate a replacement before committing it to Keychain/session
      // storage. A typo must never replace a working credential.
      setApiStatus('connecting')
      setApiError('')
      const result = await fetchCredits(candidate)
      if (!result.ok) {
        setApiStatus('error')
        setApiError(result.error ?? 'Failed to connect')
        return
      }

      try {
        if (candidate !== SECURE_API_KEY_TOKEN) {
          await host.setCredential(CLOUD_API_CREDENTIAL, candidate)
        }
      } catch {
        setApiStatus('error')
        setApiError('The API key is valid, but macOS secure storage is unavailable.')
        return
      }

      const runtimeKey = host.isPlugin() ? SECURE_API_KEY_TOKEN : candidate
      setCurrentApiKey(runtimeKey)
      updateSettings({ apiKey: runtimeKey })
      setApiCredits(result.credits ?? 0)
      setApiStatus('connected')
      setApiError('')
    },
    [updateSettings],
  )

  const refreshApiConnection = useCallback(async () => {
    const key = currentApiKey()
    if (key) await refreshCredits(key)
  }, [refreshCredits])

  // When connected, the true balance lives in EasyField Cloud — re-read it after a job.
  // Otherwise decrement the local mock balance by the actual creditsConsumed.
  const spendCredits = useCallback(
    (amount: number) => {
      if (settings.apiKey && apiStatus === 'connected') {
        refreshCredits(settings.apiKey)
        return
      }
      if (!amount || amount <= 0) return
      setCredits((c) => {
        const next = Math.max(0, c - amount)
        saveCredits(next)
        return next
      })
    },
    [settings.apiKey, apiStatus, refreshCredits],
  )

  // Route a Library creation into the matching Edit screen as its source.
  const sendToEdit = useCallback((src: EditSource) => {
    setEditSource(src)
    navigate(src.kind === 'image' ? 'edit-image' : 'edit-video')
  }, [navigate])
  // Opening an Edit screen fresh (from Home) clears any pending hand-off source.
  const openEdit = useCallback((s: Screen) => {
    setEditSource(null)
    navigate(s)
  }, [navigate])

  const openTranscriptInCaptions = useCallback(async (transcriptId: string, sourceCreationId: string) => {
    await host.setState('drafts', 'captions:incoming-transcript', { transcriptId, sourceCreationId, updatedAt: Date.now() })
    setActiveTool('captions')
    navigate('workflow')
  }, [navigate])

  return (
    <div className={`ef-panel ef-panel--${settings.windowMode}`}>
      {screen === 'home' && (
        <Home
          navigationMemory={homeNavigationMemoryRef.current}
          settings={settings}
          credits={apiCredits ?? credits}
          creditsLive={apiCredits != null}
          apiStatus={apiStatus}
          apiError={apiError}
          onConnectApiKey={connectApiKey}
          onOpenCreate={() => navigate('create')}
          onOpenCharacter={() => navigate('character')}
          onOpenCreateVideo={() => navigate('create-video')}
          onOpenEditImage={() => openEdit('edit-image')}
          onOpenEditVideo={() => openEdit('edit-video')}
          onOpenCreateMusic={() => navigate('create-music')}
          onOpenSoundEffects={() => navigate('sound-effects')}
          onOpenVoiceOver={() => navigate('voice-over')}
          onOpenAnimation={() => navigate('animation')}
          onOpenBrain={() => navigate('brain')}
          onOpenLibrary={() => navigate('library')}
          onOpenSettings={() => navigate('settings')}
          onOpenTool={openToolWorkspace}
          onToggleWindowMode={toggleWindowMode}
          windowMode={settings.windowMode}
          toast={toast}
          searchFocusSignal={searchFocusSignal}
        />
      )}
      {screen === 'create' && <CreateImage onBack={goBack} toast={toast} onSpend={spendCredits} />}
      {screen === 'character' && <CreateImage mode="character" onBack={goBack} toast={toast} onSpend={spendCredits} />}
      {screen === 'create-video' && <CreateVideo onBack={goBack} toast={toast} onSpend={spendCredits} />}
      {screen === 'edit-image' && (
        <EditImage
          onBack={goBack}
          toast={toast}
          onSpend={spendCredits}
          incomingSource={editSource?.kind === 'image' ? { url: editSource.url, name: editSource.name } : undefined}
        />
      )}
      {screen === 'edit-video' && (
        <EditVideo
          onBack={goBack}
          toast={toast}
          onSpend={spendCredits}
          incomingSource={editSource?.kind === 'video' ? { url: editSource.url, name: editSource.name } : undefined}
        />
      )}
      {screen === 'create-music' && <CreateMusic onBack={goBack} toast={toast} onSpend={spendCredits} />}
      {screen === 'sound-effects' && <SoundEffects onBack={goBack} toast={toast} onSpend={spendCredits} />}
      {screen === 'voice-over' && <VoiceOver onBack={goBack} toast={toast} onSpend={spendCredits} />}
      {screen === 'animation' && <Animation onBack={goBack} toast={toast} onSpend={spendCredits} />}
      {screen === 'brain' && <SuperBrain onBack={goBack} toast={toast} onSpend={spendCredits} />}
      {screen === 'library' && <Library onBack={goBack} onOpenCreate={() => navigate('create')} toast={toast} onSendToEdit={sendToEdit} onOpenCaptions={openTranscriptInCaptions} />}
      {screen === 'workflow' && (
        activeTool === 'upscale'
          ? <Upscale onBack={goBack} toast={toast} onSpend={spendCredits} />
        : activeTool === 'extend'
          ? <ExtendVideo onBack={goBack} toast={toast} onSpend={spendCredits} />
          : activeTool === 'transition'
            ? <TransitionVideo onBack={goBack} toast={toast} onSpend={spendCredits} />
          : activeTool === 'storyboard'
            ? <Storyboard onBack={goBack} onOpenLibrary={() => navigate('library')} toast={toast} onSpend={spendCredits} />
          : activeTool === 'angles'
            ? <Angles onBack={goBack} toast={toast} onSpend={spendCredits} />
          : activeTool === 'beat'
            ? <BeatDetection onBack={goBack} toast={toast} onToggleWindowMode={toggleWindowMode} windowMode={settings.windowMode} />
          : activeTool === 'transcribe'
            ? <Transcribe onBack={goBack} toast={toast} onToggleWindowMode={toggleWindowMode} windowMode={settings.windowMode} onOpenCaptions={openTranscriptInCaptions} />
          : activeTool === 'avatar'
            ? <Avatar onBack={goBack} toast={toast} onSpend={spendCredits} />
          : <ToolWorkspace
              toolId={activeTool}
              onBack={goBack}
              toast={toast}
              onToggleWindowMode={toggleWindowMode}
              windowMode={settings.windowMode}
            />
      )}
      {screen === 'settings' && (
        <SettingsScreen
          settings={settings}
          apiStatus={apiStatus}
          apiError={apiError}
          credits={apiCredits ?? credits}
          onBack={goBack}
          onChange={updateSettings}
          onConnectApiKey={connectApiKey}
          onRefreshApiConnection={refreshApiConnection}
          updateStatus={updateStatus}
          updateChecking={updateChecking}
          updateInstalling={updateInstalling}
          updateInstalled={updateInstalled}
          updateError={updateError}
          onCheckForUpdates={() => checkForUpdates(true)}
          onInstallUpdate={installUpdate}
        />
      )}

      <JobCenter onOpenLibrary={() => navigate('library')} />
      {updateDialogOpen && updateStatus?.available && (
        <UpdateDialog
          status={{
            currentVersion: updateStatus.currentVersion,
            latestVersion: updateStatus.candidateVersion ?? 'new build',
            releaseNotes: updateStatus.releaseNotes
              ?? (updateStatus.currentVersion === updateStatus.candidateVersion
                ? 'A newer EasyField build is ready.'
                : undefined),
          }}
          installing={updateInstalling}
          installed={updateInstalled}
          error={updateError}
          onInstall={installUpdate}
          onDismiss={dismissUpdateDialog}
        />
      )}
      <div className="ef-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {toastMsg ?? ''}
      </div>
      {toastMsg && <div className="ef-toast" aria-hidden="true">{toastMsg}</div>}
    </div>
  )
}
