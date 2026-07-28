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
  ACCOUNT_API_KEY_TOKEN,
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
import { ScreenErrorBoundary } from './components/ScreenErrorBoundary'
import { UpdateDialog } from './components/UpdateDialog'
import { hydrateJobs, recoverDurableJobs, useJobs } from './services/jobCenter'
import { host, type PluginUpdateStatus, type StateNamespace } from './services/host'
import { ToolWorkspace } from './screens/ToolWorkspace'
import { BeatDetection } from './screens/BeatDetection'
import { Transcribe } from './screens/Transcribe'
import { Upscale } from './screens/Upscale'
import { Avatar } from './screens/Avatar'
import { SettingsScreen } from './screens/SettingsScreen'
import { Account, type AccountFeedback } from './screens/Account'
import type { ToolId } from './core/contracts'
import {
  createUnavailableAccountSnapshot,
  type AccountBridgeError,
  type AccountCheckoutRequest,
  type AccountCheckoutStatus,
  type AccountPurchaseKind,
  type AccountPasswordRecoveryCompletion,
  type AccountViewSnapshot,
} from './core/accountBridge'
import {
  totalCreditMicros,
  type AccountAuthMode,
  type EmailPasswordAuthRequest,
  type PartnerCheckoutRequest,
  type PlanCheckoutRequest,
  type TopUpCheckoutRequest,
} from './core/account'
import {
  AUTO_RELOAD_DISABLED,
  DEFAULT_BILLING_INTERVAL,
  type AutoReloadPolicy,
  type BillingInterval,
  type SubscriptionPlanId,
} from './data/subscriptions'

export type ApiStatus = 'idle' | 'connecting' | 'connected' | 'error'

type Screen = 'home' | 'create' | 'character' | 'create-video' | 'edit-image' | 'edit-video' | 'create-music' | 'sound-effects' | 'voice-over' | 'animation' | 'brain' | 'library' | 'workflow' | 'settings' | 'account'

// A creation handed off from the Library to an Edit screen as its source clip.
export interface EditSource {
  kind: 'image' | 'video'
  url: string
  name?: string
}

const TOAST_MS = 1700
const CHECKOUT_REFRESH_INTERVAL_MS = 4_000
const CHECKOUT_REFRESH_ATTEMPTS = 45
const ACTIVE_JOB_STATES = new Set(['preparing', 'queued', 'running'])

type PersistedScreenState = readonly [namespace: StateNamespace, key: string]

function persistedStateForScreen(screen: Screen, activeTool: ToolId): PersistedScreenState[] {
  if (screen === 'home') return [['settings', 'home-overview']]
  if (screen === 'character') return [['drafts', 'default:character-builder']]
  if (screen === 'brain') return [['drafts', 'default:brain']]
  if (screen !== 'workflow') return []
  if (activeTool === 'storyboard') return [['drafts', 'default:storyboard-v1']]
  if (activeTool === 'angles') return [['drafts', 'default:angles']]
  if (activeTool === 'beat') return [['drafts', 'beat-detection:settings']]
  if (activeTool === 'transcribe') return [['drafts', 'transcribe:settings']]
  if (activeTool === 'captions') {
    return [
      ['drafts', 'default:captions'],
      ['drafts', 'captions:incoming-transcript'],
    ]
  }
  if (activeTool === 'upscale' || activeTool === 'extend' || activeTool === 'transition' || activeTool === 'avatar') return []
  return [['drafts', `default:${activeTool}`]]
}

function accountErrorFeedback(error: AccountBridgeError): AccountFeedback {
  return { tone: 'error', message: error.message }
}

function checkoutOpenedFeedback(input: AccountCheckoutRequest): AccountFeedback {
  if (input.kind === 'billing-portal') {
    return {
      tone: 'neutral',
      message: 'Billing portal opened in your browser. Return here and refresh your account after making changes.',
    }
  }
  if (input.kind === 'upstream-top-up') {
    return {
      tone: 'neutral',
      message: 'Provider credit purchase opened in your browser. Return here and refresh your balance after purchase.',
    }
  }
  return {
    tone: 'neutral',
    message: 'Secure checkout opened in your browser. Access updates only after payment is verified.',
  }
}

function checkoutKindLabel(kind: AccountPurchaseKind): string {
  if (kind === 'subscription') return 'Plan'
  if (kind === 'top-up') return 'Credit top-up'
  return 'Partner'
}

function checkoutRecoverySummary(status: AccountCheckoutStatus): { title: string; action: string } {
  const kind = checkoutKindLabel(status.kind)
  if (status.state === 'pending') return { title: `${kind} checkout is open`, action: 'Review checkout' }
  if (status.state === 'ready-to-resume') return { title: `${kind} checkout can be resumed`, action: 'Resume checkout' }
  if (status.state === 'awaiting-reconciliation') return { title: `${kind} payment needs a status check`, action: 'Review payment' }
  if (status.state === 'completed') return { title: `${kind} payment confirmed`, action: 'View account' }
  return { title: `${kind} checkout closed`, action: 'View account' }
}

function checkoutStatusMarker(status: AccountCheckoutStatus): string {
  const timestamp = 'startedAtMs' in status ? status.startedAtMs : status.updatedAtMs
  return `${status.kind}:${status.state}:${timestamp}`
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('home')
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [credits, setCredits] = useState<number>(loadCredits)
  const [apiCredits, setApiCredits] = useState<number | null>(null)
  const [apiStatus, setApiStatus] = useState<ApiStatus>('idle')
  const [apiError, setApiError] = useState<string>('')
  const [hasExistingDirectCredential, setHasExistingDirectCredential] = useState(false)
  const [hasScopedDirectCredential, setHasScopedDirectCredential] = useState(false)
  const jobs = useJobs()
  const activeJobCount = jobs.reduce((count, job) => count + (ACTIVE_JOB_STATES.has(job.status) ? 1 : 0), 0)
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
  const [accountSnapshot, setAccountSnapshot] = useState<AccountViewSnapshot>(createUnavailableAccountSnapshot)
  const [accountAuthMode, setAccountAuthMode] = useState<AccountAuthMode>('sign-in')
  const [accountAuthEmail, setAccountAuthEmail] = useState('')
  const [accountAuthPassword, setAccountAuthPassword] = useState('')
  const [accountAuthPending, setAccountAuthPending] = useState(false)
  const [accountAuthFeedback, setAccountAuthFeedback] = useState<AccountFeedback | null>(null)
  const [passwordResetPending, setPasswordResetPending] = useState(false)
  const [passwordResetFeedback, setPasswordResetFeedback] = useState<AccountFeedback | null>(null)
  const [passwordRecovery, setPasswordRecovery] = useState<AccountPasswordRecoveryCompletion | null>(null)
  const [passwordRecoveryPending, setPasswordRecoveryPending] = useState(false)
  const [passwordRecoveryFeedback, setPasswordRecoveryFeedback] = useState<AccountFeedback | null>(null)
  const [profilePending, setProfilePending] = useState(false)
  const [profileFeedback, setProfileFeedback] = useState<AccountFeedback | null>(null)
  const [accountRestoreComplete, setAccountRestoreComplete] = useState(false)
  const [verificationPending, setVerificationPending] = useState(false)
  const [accountRefreshPending, setAccountRefreshPending] = useState(false)
  const [accountRefreshFeedback, setAccountRefreshFeedback] = useState<AccountFeedback | null>(null)
  const [checkoutResumePending, setCheckoutResumePending] = useState(false)
  const [dismissedCheckoutStatusMarker, setDismissedCheckoutStatusMarker] = useState('')
  const [selectedPlanId, setSelectedPlanId] = useState<SubscriptionPlanId>('starter')
  const [billingInterval, setBillingInterval] = useState<BillingInterval>(DEFAULT_BILLING_INTERVAL)
  const [planCheckoutPending, setPlanCheckoutPending] = useState(false)
  const [planFeedback, setPlanFeedback] = useState<AccountFeedback | null>(null)
  const [partnerCheckoutPending, setPartnerCheckoutPending] = useState(false)
  const [partnerFeedback, setPartnerFeedback] = useState<AccountFeedback | null>(null)
  const [topUpCredits, setTopUpCredits] = useState('')
  const [topUpPending, setTopUpPending] = useState(false)
  const [topUpFeedback, setTopUpFeedback] = useState<AccountFeedback | null>(null)
  const [autoReloadPolicy, setAutoReloadPolicy] = useState<AutoReloadPolicy>(AUTO_RELOAD_DISABLED)
  const [autoReloadPending, setAutoReloadPending] = useState(false)
  const [autoReloadFeedback, setAutoReloadFeedback] = useState<AccountFeedback | null>(null)
  const [upstreamTopUpPending, setUpstreamTopUpPending] = useState(false)
  const [upstreamTopUpFeedback, setUpstreamTopUpFeedback] = useState<AccountFeedback | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settingsHydratedRef = useRef(false)
  const legacyApiKeyRef = useRef(settings.apiKey.trim())
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
  const accountRevisionRef = useRef(-1)
  const accountIdentityRef = useRef<string | null>(null)
  const accountUiEpochRef = useRef(0)
  const accountOAuthAttemptRef = useRef<string | null>(null)
  const accountPasswordRecoveryAttemptRef = useRef<string | null>(null)
  const accountOAuthTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const checkoutWatchRef = useRef(0)
  const checkoutStatusMarkerRef = useRef('')
  const updateCheckInFlightRef = useRef(false)

  const applyAccountSnapshot = useCallback((snapshot: AccountViewSnapshot) => {
    if (snapshot.revision < accountRevisionRef.current) return
    accountRevisionRef.current = snapshot.revision
    const nextAccountId = snapshot.session.status === 'signed-in' ? snapshot.session.accountId : null
    if (accountIdentityRef.current !== nextAccountId) {
      const previousAccountId = accountIdentityRef.current
      accountIdentityRef.current = nextAccountId
      accountUiEpochRef.current += 1
      checkoutWatchRef.current += 1
      checkoutStatusMarkerRef.current = ''
      const awaitingOAuthSuccess = previousAccountId == null
        && nextAccountId != null
        && accountOAuthAttemptRef.current != null
      if (!awaitingOAuthSuccess) {
        accountOAuthAttemptRef.current = null
        if (accountOAuthTimerRef.current) clearTimeout(accountOAuthTimerRef.current)
        accountOAuthTimerRef.current = null
      } else {
        const attemptId = accountOAuthAttemptRef.current
        if (accountOAuthTimerRef.current) clearTimeout(accountOAuthTimerRef.current)
        accountOAuthTimerRef.current = setTimeout(() => {
          if (accountOAuthAttemptRef.current !== attemptId || accountIdentityRef.current !== nextAccountId) return
          accountOAuthAttemptRef.current = null
          accountOAuthTimerRef.current = null
          setAccountAuthPending(false)
          setAccountAuthFeedback({ tone: 'success', message: 'Signed in securely.' })
        }, 1_000)
      }
      setAccountAuthMode('sign-in')
      setAccountAuthEmail('')
      setAccountAuthPassword('')
      setAccountAuthPending(false)
      setAccountAuthFeedback(null)
      setPasswordResetPending(false)
      setPasswordResetFeedback(null)
      setProfilePending(false)
      setProfileFeedback(null)
      setVerificationPending(false)
      setAccountRefreshPending(false)
      setAccountRefreshFeedback(null)
      setCheckoutResumePending(false)
      setDismissedCheckoutStatusMarker('')
      setPlanCheckoutPending(false)
      setPlanFeedback(null)
      setPartnerCheckoutPending(false)
      setPartnerFeedback(null)
      setTopUpCredits('')
      setTopUpPending(false)
      setTopUpFeedback(null)
      setAutoReloadPending(false)
      setAutoReloadFeedback(null)
      setUpstreamTopUpPending(false)
      setUpstreamTopUpFeedback(null)
      setApiCredits(null)
      setApiStatus('idle')
      setApiError('')
      setHasExistingDirectCredential(false)
      setHasScopedDirectCredential(false)
      setCurrentApiKey('')
      setSettings((current) => current.apiKey ? { ...current, apiKey: '' } : current)
    }
    setAccountSnapshot(snapshot)
    setAutoReloadPolicy(snapshot.autoReloadPolicy)
    if (snapshot.subscription) {
      setSelectedPlanId(snapshot.subscription.planId)
    } else {
      setSelectedPlanId('starter')
    }
  }, [])

  const accountRuntimeIdentity = accountSnapshot.session.status === 'signed-in'
    ? accountSnapshot.session.accountId
    : ''
  const accountSignedIn = accountSnapshot.session.status === 'signed-in'

  const navigate = useCallback((next: Screen) => {
    const current = screenRef.current
    if (current === next) return
    if (next === 'account') setBillingInterval(DEFAULT_BILLING_INTERVAL)
    navigationHistoryRef.current = [...navigationHistoryRef.current.slice(-29), current]
    screenRef.current = next
    setScreen(next)
  }, [])

  const goBack = useCallback(() => {
    const previous = navigationHistoryRef.current.pop() ?? 'home'
    screenRef.current = previous
    setScreen(previous)
  }, [])

  const recoverHome = useCallback(() => {
    navigationHistoryRef.current = []
    screenRef.current = 'home'
    setEditSource(null)
    setScreen('home')
  }, [])

  useEffect(() => {
    let active = true
    const unsubscribe = host.account.onChanged((snapshot) => {
      if (active) applyAccountSnapshot(snapshot)
    })
    const unsubscribeOAuth = host.account.onOAuthCompleted((completion) => {
      if (!active || accountOAuthAttemptRef.current !== completion.attemptId) return
      accountOAuthAttemptRef.current = null
      if (accountOAuthTimerRef.current) clearTimeout(accountOAuthTimerRef.current)
      accountOAuthTimerRef.current = null
      setAccountAuthPending(false)
      setAccountAuthFeedback({
        tone: completion.state === 'authenticated' ? 'success' : 'error',
        message: completion.message,
      })
    })
    const unsubscribePasswordRecovery = host.account.onPasswordRecoveryCompleted((completion) => {
      if (!active || accountPasswordRecoveryAttemptRef.current !== completion.attemptId) return
      if (completion.state === 'ready') {
        setPasswordRecovery(completion)
        setPasswordRecoveryFeedback(null)
        navigate('account')
        return
      }
      accountPasswordRecoveryAttemptRef.current = null
      setPasswordRecovery(null)
      setPasswordRecoveryPending(false)
      setPasswordRecoveryFeedback({
        tone: completion.state === 'completed' ? 'success' : completion.state === 'cancelled' ? 'neutral' : 'error',
        message: completion.message,
      })
      setPasswordResetFeedback({
        tone: completion.state === 'completed' ? 'success' : completion.state === 'cancelled' ? 'neutral' : 'error',
        message: completion.message,
      })
    })
    void host.account.restore().then((result) => {
      if (!active) return
      if (result.ok) {
        applyAccountSnapshot(result.value)
        setAccountAuthFeedback(null)
      } else {
        setAccountAuthFeedback(accountErrorFeedback(result.error))
      }
      setAccountRestoreComplete(true)
    })
    return () => {
      active = false
      unsubscribe()
      unsubscribeOAuth()
      unsubscribePasswordRecovery()
    }
  }, [applyAccountSnapshot, navigate])

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

  // Width density and vertical fit are independent. Main owns the display
  // work-area calculation so renderer code never guesses native window bounds.
  useEffect(() => {
    void host.setWindowLayout(settings.windowMode, settings.windowHeightMode)
  }, [settings.windowMode, settings.windowHeightMode])

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    if (accountOAuthTimerRef.current) clearTimeout(accountOAuthTimerRef.current)
    checkoutWatchRef.current += 1
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

  const toggleWindowHeight = useCallback(() => {
    setSettings((current) => ({
      ...current,
      windowHeightMode: current.windowHeightMode === 'standard' ? 'full' : 'standard',
    }))
  }, [])

  const openToolWorkspace = useCallback((toolId: ToolId) => {
    setActiveTool(toolId)
    navigate('workflow')
  }, [navigate])

  // Read the live EasyField Cloud credit balance for the given key.
  const refreshCredits = useCallback(async (key: string, isCurrent: () => boolean = () => true) => {
    if (!isCurrent()) return false
    if (!key.trim()) {
      setApiCredits(null)
      setApiStatus('idle')
      setApiError('')
      return false
    }
    setApiStatus('connecting')
    const r = await fetchCredits(key)
    if (!isCurrent()) return false
    if (r.ok) {
      setApiCredits(r.credits ?? 0)
      setApiStatus('connected')
      setApiError('')
      return true
    } else {
      setApiCredits(null)
      setApiStatus('error')
      setApiError(r.error ?? 'Failed to connect')
      return false
    }
  }, [])

  // Select exactly one renderer sentinel after Main restores account authority.
  // A regular account never receives the direct-provider sentinel, while a
  // stored direct credential is ignored unless Main explicitly permits it.
  useEffect(() => {
    if (!accountRestoreComplete) return
    let active = true
    void (async () => {
      if (accountSnapshot.capabilities.directProviderAllowed) {
        // A configured account may read only its Main-owned, account-scoped
        // credential. Never attach a legacy renderer value to whichever user
        // happened to sign in next.
        const legacyKey = accountSnapshot.capabilities.accountConfigured ? '' : legacyApiKeyRef.current
        let securedKey = ''
        try {
          securedKey = await host.getCredential(CLOUD_API_CREDENTIAL)
        } catch {
          securedKey = ''
        }
        const key = securedKey || legacyKey
        if (legacyKey && !securedKey) {
          try {
            await host.setCredential(CLOUD_API_CREDENTIAL, legacyKey)
          } catch {
            // Continue into the normal connection check, which surfaces the
            // unavailable secure credential without aborting account boot.
          }
        }
        if (!active) return
        if (key) {
          const runtimeKey = host.isPlugin() ? SECURE_API_KEY_TOKEN : key
          setCurrentApiKey(runtimeKey)
          setSettings((current) => ({ ...current, apiKey: runtimeKey }))
          const refreshed = await refreshCredits(runtimeKey, () => active)
          if (active && refreshed) await recoverDurableJobs()
          return
        }

        // Admin and Partner use only their own direct account. Falling through
        // to the customer gateway here could spend the operator account when a
        // Partner has not connected their own credential yet.
        setCurrentApiKey('')
        setSettings((current) => ({ ...current, apiKey: '' }))
        setApiCredits(null)
        setApiStatus('idle')
        setApiError('')
        return
      }

      if (accountSnapshot.capabilities.generationAccess) {
        setCurrentApiKey(ACCOUNT_API_KEY_TOKEN)
        setSettings((current) => ({ ...current, apiKey: '' }))
        setApiCredits(null)
        setApiStatus('idle')
        setApiError('')
        await recoverDurableJobs()
        return
      }

      setCurrentApiKey('')
      setSettings((current) => ({ ...current, apiKey: '' }))
      setApiCredits(null)
      setApiStatus('idle')
      setApiError('')
    })()
    return () => { active = false }
  }, [accountRestoreComplete, accountRuntimeIdentity, accountSnapshot.capabilities.accountConfigured, accountSnapshot.capabilities.directProviderAllowed, accountSnapshot.capabilities.generationAccess, refreshCredits])

  useEffect(() => {
    let active = true
    setHasExistingDirectCredential(false)
    if (
      !accountRestoreComplete
      || !host.isPlugin()
      || !accountSnapshot.capabilities.directProviderAllowed
      || apiStatus === 'connected'
    ) return () => { active = false }
    const uiEpoch = accountUiEpochRef.current
    void host.hasExistingDirectCloudCredential().then((available) => {
      if (active && accountUiEpochRef.current === uiEpoch) setHasExistingDirectCredential(available)
    })
    return () => { active = false }
  }, [accountRestoreComplete, accountRuntimeIdentity, accountSnapshot.capabilities.directProviderAllowed, apiStatus])

  // Credential presence is distinct from entitlement and from the legacy
  // adoption candidate. Keeping this delete-only signal lets a signed-in user
  // remove their own encrypted Mac credential even after access is revoked.
  useEffect(() => {
    let active = true
    setHasScopedDirectCredential(false)
    if (!accountRestoreComplete || !host.isPlugin() || !accountSignedIn) return () => { active = false }
    const uiEpoch = accountUiEpochRef.current
    void host.hasCurrentAccountDirectCloudCredential().then((present) => {
      if (active && accountUiEpochRef.current === uiEpoch) setHasScopedDirectCredential(present)
    })
    return () => { active = false }
  }, [accountRestoreComplete, accountRuntimeIdentity, accountSignedIn, accountSnapshot.capabilities.directProviderAllowed])

  const connectApiKey = useCallback(
    async (key: string) => {
      const uiEpoch = accountUiEpochRef.current
      const isCurrent = () => accountUiEpochRef.current === uiEpoch
      if (!accountSnapshot.capabilities.directProviderAllowed) {
        setApiCredits(null)
        setApiStatus('error')
        setApiError('Direct provider access is not available for this account.')
        return
      }
      const candidate = key.trim()
      if (!candidate) {
        setApiCredits(null)
        setApiStatus('error')
        setApiError('Enter your direct cloud credential to connect.')
        return
      }

      // The secure sentinel means Main already owns the encrypted credential.
      // A refresh must use the loopback proxy; sending the sentinel to the
      // direct-connect IPC would incorrectly validate it as if it were the
      // real credential and could make a healthy saved connection look broken.
      if (candidate === SECURE_API_KEY_TOKEN) {
        if (!host.isPlugin() || currentApiKey() !== SECURE_API_KEY_TOKEN) {
          setApiCredits(null)
          setApiStatus('error')
          setApiError('The saved direct cloud connection is unavailable.')
          return
        }
        await refreshCredits(SECURE_API_KEY_TOKEN, isCurrent)
        return
      }

      // In the plugin, Main verifies the account entitlement and candidate,
      // then atomically stores it in that account's Keychain scope. The raw
      // candidate is never sent through the packaged loopback provider proxy.
      setApiStatus('connecting')
      setApiError('')
      let credits = 0
      try {
        if (host.isPlugin()) {
          const result = await host.connectDirectCloudCredential(candidate)
          credits = result.credits
        } else {
          const result = await fetchCredits(candidate)
          if (!isCurrent()) return
          if (!result.ok) {
            setApiStatus('error')
            setApiError(result.error ?? 'Failed to connect')
            return
          }
          credits = result.credits ?? 0
          await host.setCredential(CLOUD_API_CREDENTIAL, candidate)
        }
      } catch {
        if (!isCurrent()) return
        setApiStatus('error')
        setApiError('Could not verify the direct cloud credential. Check the credential and connection, then try again.')
        return
      }

      if (!isCurrent()) return
      const runtimeKey = host.isPlugin() ? SECURE_API_KEY_TOKEN : candidate
      setCurrentApiKey(runtimeKey)
      updateSettings({ apiKey: runtimeKey })
      setApiCredits(credits)
      setApiStatus('connected')
      setApiError('')
      setHasScopedDirectCredential(host.isPlugin())
    },
    [accountSnapshot.capabilities.directProviderAllowed, refreshCredits, updateSettings],
  )

  const refreshApiConnection = useCallback(async () => {
    if (!accountSnapshot.capabilities.directProviderAllowed) return
    const uiEpoch = accountUiEpochRef.current
    const key = currentApiKey()
    if (key && key !== ACCOUNT_API_KEY_TOKEN) await refreshCredits(key, () => accountUiEpochRef.current === uiEpoch)
  }, [accountSnapshot.capabilities.directProviderAllowed, refreshCredits])

  const adoptExistingDirectConnection = useCallback(async () => {
    if (!accountSnapshot.capabilities.directProviderAllowed || !hasExistingDirectCredential) return
    const uiEpoch = accountUiEpochRef.current
    setApiStatus('connecting')
    setApiError('')
    try {
      const result = await host.adoptExistingDirectCloudCredential()
      if (accountUiEpochRef.current !== uiEpoch) return
      setCurrentApiKey(SECURE_API_KEY_TOKEN)
      updateSettings({ apiKey: SECURE_API_KEY_TOKEN })
      setApiCredits(result.credits)
      setApiStatus('connected')
      setApiError('')
      setHasExistingDirectCredential(false)
      setHasScopedDirectCredential(true)
    } catch {
      if (accountUiEpochRef.current !== uiEpoch) return
      setApiCredits(null)
      setApiStatus('error')
      setApiError('Could not verify the saved Mac connection. You can enter a different credential instead.')
    }
  }, [accountSnapshot.capabilities.directProviderAllowed, hasExistingDirectCredential, updateSettings])

  const disconnectDirectConnection = useCallback(async (): Promise<void> => {
    if (!accountSignedIn || apiStatus === 'connecting') return
    if (activeJobCount > 0) throw new Error('Active jobs must finish before disconnecting.')
    const uiEpoch = accountUiEpochRef.current
    const wasConnected = apiCredits != null || currentApiKey() === SECURE_API_KEY_TOKEN
    setApiStatus('connecting')
    setApiError('')
    try {
      await host.deleteCredential(CLOUD_API_CREDENTIAL)
      if (accountUiEpochRef.current !== uiEpoch) return
      setCurrentApiKey('')
      updateSettings({ apiKey: '' })
      setApiCredits(null)
      setHasExistingDirectCredential(false)
      setHasScopedDirectCredential(false)
      setApiStatus('idle')
    } catch {
      if (accountUiEpochRef.current !== uiEpoch) return
      setApiStatus(wasConnected ? 'connected' : 'error')
      setApiError('EasyField could not remove the saved connection. Try again.')
      throw new Error('EasyField could not remove the saved connection.')
    }
  }, [accountSignedIn, activeJobCount, apiCredits, apiStatus, updateSettings])

  // When connected, the authoritative balance lives in EasyField Cloud — re-read it after a job.
  // The remaining branch preserves the legacy direct-connection development balance.
  const spendCredits = useCallback(
    (amount: number) => {
      if (currentApiKey() === ACCOUNT_API_KEY_TOKEN) {
        void host.account.getSnapshot({ force: true }).then((result) => {
          if (result.ok) applyAccountSnapshot(result.value)
        })
        return
      }
      if (settings.apiKey && apiStatus === 'connected') {
        const uiEpoch = accountUiEpochRef.current
        void refreshCredits(settings.apiKey, () => accountUiEpochRef.current === uiEpoch)
        return
      }
      if (!amount || amount <= 0) return
      setCredits((c) => {
        const next = Math.max(0, c - amount)
        saveCredits(next)
        return next
      })
    },
    [apiStatus, applyAccountSnapshot, refreshCredits, settings.apiKey],
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

  const requestEmailPasswordAuth = useCallback(async (request: EmailPasswordAuthRequest) => {
    setAccountAuthPending(true)
    setAccountAuthFeedback(null)
    try {
      const result = request.mode === 'sign-up'
        ? await host.account.signUp({ email: request.email, password: request.password })
        : await host.account.signIn({ email: request.email, password: request.password })
      if (!result.ok) {
        setAccountAuthFeedback(accountErrorFeedback(result.error))
        return
      }
      if (result.value.state === 'verification-required') {
        setAccountAuthEmail(result.value.email)
        setAccountAuthMode('sign-in')
        setAccountAuthFeedback({ tone: 'success', message: 'Check your email to verify the account, then sign in.' })
        return
      }
      applyAccountSnapshot(result.value.snapshot)
      setAccountAuthFeedback(result.value.state === 'authenticated'
        ? { tone: 'success', message: 'Signed in securely.' }
        : null)
    } finally {
      setAccountAuthPassword('')
      setAccountAuthPending(false)
    }
  }, [applyAccountSnapshot])

  const requestSocialAuth = useCallback(async (provider: 'google' | 'apple') => {
    setAccountAuthPending(true)
    setAccountAuthFeedback(null)
    const result = await host.account.startOAuth({ provider })
    if (!result.ok) {
      accountOAuthAttemptRef.current = null
      setAccountAuthPending(false)
      setAccountAuthFeedback(accountErrorFeedback(result.error))
      return
    }
    accountOAuthAttemptRef.current = result.value.attemptId
    setAccountAuthFeedback({ tone: 'neutral', message: `Finish signing in with ${provider === 'google' ? 'Google' : 'Apple'} in your browser.` })
    if (accountOAuthTimerRef.current) clearTimeout(accountOAuthTimerRef.current)
    const attemptId = result.value.attemptId
    accountOAuthTimerRef.current = setTimeout(() => {
      if (accountOAuthAttemptRef.current !== attemptId) return
      accountOAuthAttemptRef.current = null
      accountOAuthTimerRef.current = null
      setAccountAuthPending(false)
      setAccountAuthFeedback({ tone: 'error', message: 'Social sign-in expired. Try again.' })
    }, Math.max(0, result.value.expiresAtMs - Date.now()) + 250)
  }, [])

  const requestResendVerification = useCallback(async () => {
    const email = accountSnapshot.session.status === 'signed-in'
      ? accountSnapshot.session.email
      : accountAuthEmail.trim()
    if (!email) {
      setAccountAuthFeedback({ tone: 'error', message: 'Enter your email address first.' })
      return
    }
    const uiEpoch = accountUiEpochRef.current
    setVerificationPending(true)
    try {
      const result = await host.account.resendVerification({ email })
      if (accountUiEpochRef.current !== uiEpoch) return
      setAccountAuthFeedback(result.ok
        ? { tone: 'success', message: 'If verification is pending, a new email is on the way.' }
        : accountErrorFeedback(result.error))
    } finally {
      if (accountUiEpochRef.current === uiEpoch) setVerificationPending(false)
    }
  }, [accountAuthEmail, accountSnapshot.session])

  const requestPasswordReset = useCallback(async (email: string) => {
    const normalizedEmail = email.trim()
    if (!normalizedEmail) {
      setPasswordResetFeedback({ tone: 'error', message: 'Enter your email address first.' })
      return
    }
    setPasswordResetPending(true)
    setPasswordResetFeedback(null)
    try {
      const result = await host.account.requestPasswordReset({ email: normalizedEmail })
      if (!result.ok) {
        setPasswordResetFeedback(accountErrorFeedback(result.error))
        return
      }
      accountPasswordRecoveryAttemptRef.current = result.value.attemptId
      setPasswordRecovery(null)
      setPasswordRecoveryFeedback(null)
      setPasswordResetFeedback({ tone: 'success', message: 'If an account matches that email, recovery instructions are on the way.' })
    } finally {
      setPasswordResetPending(false)
    }
  }, [])

  const completePasswordRecovery = useCallback(async (attemptId: string, password: string) => {
    if (accountPasswordRecoveryAttemptRef.current !== attemptId) return
    setPasswordRecoveryPending(true)
    setPasswordRecoveryFeedback(null)
    try {
      const result = await host.account.completePasswordRecovery({ attemptId, password })
      if (!result.ok) {
        setPasswordRecoveryFeedback(accountErrorFeedback(result.error))
        return
      }
      applyAccountSnapshot(result.value.snapshot)
      accountPasswordRecoveryAttemptRef.current = null
      setPasswordRecovery(null)
      setPasswordResetFeedback({ tone: 'success', message: 'Password updated. Sign in with your new password.' })
    } finally {
      setPasswordRecoveryPending(false)
    }
  }, [applyAccountSnapshot])

  const cancelPasswordRecovery = useCallback(async (attemptId: string) => {
    if (accountPasswordRecoveryAttemptRef.current !== attemptId) return
    setPasswordRecoveryPending(true)
    try {
      const result = await host.account.cancelPasswordRecovery({ attemptId })
      if (!result.ok) {
        setPasswordRecoveryFeedback(accountErrorFeedback(result.error))
        return
      }
      accountPasswordRecoveryAttemptRef.current = null
      setPasswordRecovery(null)
      setPasswordResetFeedback({ tone: 'neutral', message: 'Password recovery was cancelled.' })
    } finally {
      setPasswordRecoveryPending(false)
    }
  }, [])

  const requestProfileUpdate = useCallback(async (displayName: string) => {
    setProfilePending(true)
    setProfileFeedback(null)
    try {
      const result = await host.account.updateProfile({ displayName })
      if (!result.ok) {
        setProfileFeedback(accountErrorFeedback(result.error))
        return
      }
      applyAccountSnapshot(result.value)
      setProfileFeedback({ tone: 'success', message: 'Display name updated.' })
    } finally {
      setProfilePending(false)
    }
  }, [applyAccountSnapshot])

  const requestSignOut = useCallback(async () => {
    if (activeJobCount > 0) {
      setAccountAuthFeedback({ tone: 'error', message: `Finish ${activeJobCount} active job${activeJobCount === 1 ? '' : 's'} before signing out.` })
      return
    }
    checkoutWatchRef.current += 1
    setAccountAuthPending(true)
    try {
      const result = await host.account.signOut()
      if (result.ok) {
        applyAccountSnapshot(result.value.snapshot)
        setAccountAuthFeedback({ tone: 'success', message: 'Signed out.' })
      } else {
        setAccountAuthFeedback(accountErrorFeedback(result.error))
      }
    } finally {
      setAccountAuthPassword('')
      setAccountAuthPending(false)
    }
  }, [activeJobCount, applyAccountSnapshot])

  const setPurchaseFeedback = useCallback((kind: AccountPurchaseKind, value: AccountFeedback | null) => {
    if (kind === 'subscription') setPlanFeedback(value)
    else if (kind === 'top-up') setTopUpFeedback(value)
    else setPartnerFeedback(value)
  }, [])

  const watchPendingCheckout = useCallback((status: Extract<AccountCheckoutStatus, { state: 'pending' }>) => {
    const watchId = checkoutWatchRef.current + 1
    const uiEpoch = accountUiEpochRef.current
    checkoutWatchRef.current = watchId
    setPurchaseFeedback(status.kind, {
      tone: 'neutral',
      message: 'Checkout is open. EasyField will update access or credits only after payment is confirmed.',
    })
    void (async () => {
      for (let attempt = 0; attempt < CHECKOUT_REFRESH_ATTEMPTS; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, CHECKOUT_REFRESH_INTERVAL_MS))
        if (checkoutWatchRef.current !== watchId || accountUiEpochRef.current !== uiEpoch) return
        const refreshed = await host.account.getSnapshot({ force: true })
        if (!refreshed.ok || checkoutWatchRef.current !== watchId || accountUiEpochRef.current !== uiEpoch) continue
        applyAccountSnapshot(refreshed.value)
        if (refreshed.value.session.status !== 'signed-in') return
        if (refreshed.value.checkoutStatus?.state !== 'pending') return
      }
      if (checkoutWatchRef.current === watchId && accountUiEpochRef.current === uiEpoch) {
        setPurchaseFeedback(status.kind, {
          tone: 'neutral',
          message: 'Payment has not been confirmed yet. If checkout is complete, choose Refresh account to check again.',
        })
      }
    })()
  }, [applyAccountSnapshot, setPurchaseFeedback])

  useEffect(() => {
    const status = accountSnapshot.checkoutStatus
    if (accountSnapshot.session.status !== 'signed-in' || !status) return
    const timestamp = 'startedAtMs' in status ? status.startedAtMs : status.updatedAtMs
    const marker = `${accountSnapshot.session.accountId}:${status.kind}:${status.state}:${timestamp}`
    if (checkoutStatusMarkerRef.current === marker) return
    checkoutStatusMarkerRef.current = marker

    if (status.state === 'pending') {
      watchPendingCheckout(status)
      return
    }

    checkoutWatchRef.current += 1
    if (status.state === 'ready-to-resume') {
      setPurchaseFeedback(status.kind, {
        tone: 'neutral',
        message: 'Checkout was prepared but the browser step was interrupted. Choose Resume checkout to continue the same purchase.',
      })
      return
    }
    if (status.state === 'awaiting-reconciliation') {
      setPurchaseFeedback(status.kind, {
        tone: 'neutral',
        message: 'EasyField cannot verify the final result yet. Check the payment status before starting another purchase.',
      })
      return
    }
    setPurchaseFeedback(status.kind, status.state === 'completed'
      ? { tone: 'success', message: 'Payment confirmed. Your account access and credits are now updated.' }
      : { tone: 'neutral', message: 'Checkout closed with no payment. You can start a new checkout whenever you are ready.' })
  }, [accountSnapshot.checkoutStatus, accountSnapshot.session, setPurchaseFeedback, watchPendingCheckout])

  const requestCheckout = useCallback(async (
    input: AccountCheckoutRequest,
    setPending: (value: boolean) => void,
    setFeedback: (value: AccountFeedback | null) => void,
  ) => {
    const uiEpoch = accountUiEpochRef.current
    setPending(true)
    setFeedback(null)
    try {
      const result = await host.account.checkout(input)
      if (accountUiEpochRef.current !== uiEpoch) return
      if (!result.ok) {
        setFeedback(accountErrorFeedback(result.error))
        return
      }
      setFeedback(checkoutOpenedFeedback(input))
      if (input.kind === 'subscription' || input.kind === 'top-up' || input.kind === 'partner') {
        const refreshed = await host.account.getSnapshot({ force: true })
        if (refreshed.ok && accountUiEpochRef.current === uiEpoch) applyAccountSnapshot(refreshed.value)
      }
    } finally {
      if (accountUiEpochRef.current === uiEpoch) setPending(false)
    }
  }, [applyAccountSnapshot])

  const requestPlanCheckout = useCallback((request: PlanCheckoutRequest) => requestCheckout(
    { kind: 'subscription', planId: request.planId, billingInterval: request.billingInterval },
    setPlanCheckoutPending,
    setPlanFeedback,
  ), [requestCheckout])

  const requestPartnerCheckout = useCallback((_request: PartnerCheckoutRequest) => requestCheckout(
    { kind: 'partner' },
    setPartnerCheckoutPending,
    setPartnerFeedback,
  ), [requestCheckout])

  const requestTopUpCheckout = useCallback((request: TopUpCheckoutRequest) => requestCheckout(
    { kind: 'top-up', amountCreditMicros: request.amountCreditMicros },
    setTopUpPending,
    setTopUpFeedback,
  ), [requestCheckout])

  const requestBillingPortal = useCallback(() => requestCheckout(
    { kind: 'billing-portal' },
    setPlanCheckoutPending,
    setPlanFeedback,
  ), [requestCheckout])

  const requestUpstreamTopUp = useCallback(() => requestCheckout(
    { kind: 'upstream-top-up' },
    setUpstreamTopUpPending,
    setUpstreamTopUpFeedback,
  ), [requestCheckout])

  const requestResumeCheckout = useCallback(async () => {
    const status = accountSnapshot.checkoutStatus
    if (!status || (status.state !== 'pending' && status.state !== 'ready-to-resume')) return
    const uiEpoch = accountUiEpochRef.current
    setCheckoutResumePending(true)
    setAccountRefreshFeedback(null)
    setPurchaseFeedback(status.kind, null)
    try {
      const result = await host.account.resumeCheckout()
      if (accountUiEpochRef.current !== uiEpoch) return
      if (!result.ok) {
        const feedback = accountErrorFeedback(result.error)
        setAccountRefreshFeedback(feedback)
        setPurchaseFeedback(status.kind, feedback)
        return
      }
      const reopenedFeedback: AccountFeedback = {
        tone: 'neutral',
        message: 'The same secure checkout was reopened. Access changes only after payment is confirmed.',
      }
      setAccountRefreshFeedback(reopenedFeedback)
      setPurchaseFeedback(status.kind, reopenedFeedback)
      const refreshed = await host.account.getSnapshot({ force: true })
      if (refreshed.ok && accountUiEpochRef.current === uiEpoch) applyAccountSnapshot(refreshed.value)
    } finally {
      if (accountUiEpochRef.current === uiEpoch) setCheckoutResumePending(false)
    }
  }, [accountSnapshot.checkoutStatus, applyAccountSnapshot, setPurchaseFeedback])

  const requestAccountRefresh = useCallback(async () => {
    const uiEpoch = accountUiEpochRef.current
    setAccountRefreshPending(true)
    setAccountRefreshFeedback(null)
    try {
      const result = await host.account.getSnapshot({ force: true })
      if (accountUiEpochRef.current !== uiEpoch) return
      if (result.ok) {
        applyAccountSnapshot(result.value)
        const directBalanceUpdated = result.value.capabilities.directProviderAllowed && currentApiKey() === SECURE_API_KEY_TOKEN
          ? await refreshCredits(SECURE_API_KEY_TOKEN, () => accountUiEpochRef.current === uiEpoch)
          : true
        if (accountUiEpochRef.current !== uiEpoch) return
        const checkoutStatus = result.value.checkoutStatus
        if (checkoutStatus?.state === 'pending') watchPendingCheckout(checkoutStatus)
        if (accountUiEpochRef.current === uiEpoch) {
          const feedback: AccountFeedback = checkoutStatus?.state === 'pending'
            ? { tone: 'neutral', message: 'Account refreshed. Your checkout is still open.' }
            : checkoutStatus?.state === 'ready-to-resume'
              ? { tone: 'neutral', message: 'Account refreshed. This checkout is ready to resume.' }
              : checkoutStatus?.state === 'awaiting-reconciliation'
                ? { tone: 'neutral', message: 'Account refreshed. The final payment result is still unavailable.' }
                : checkoutStatus?.state === 'completed'
                  ? { tone: 'success', message: 'Payment confirmed. Access and credits are up to date.' }
                  : checkoutStatus?.state === 'closed-unpaid'
                    ? { tone: 'neutral', message: 'Checkout closed without payment. You can start another purchase.' }
                    : directBalanceUpdated
                      ? { tone: 'success', message: 'Account status, access and credits are up to date.' }
                      : { tone: 'error', message: 'Account access refreshed, but the direct credit balance is unavailable.' }
          setAccountRefreshFeedback(feedback)
        }
      } else {
        setAccountRefreshFeedback(accountErrorFeedback(result.error))
      }
    } finally {
      if (accountUiEpochRef.current === uiEpoch) setAccountRefreshPending(false)
    }
  }, [applyAccountSnapshot, refreshCredits, watchPendingCheckout])

  const requestSaveAutoReload = useCallback(async (policy: AutoReloadPolicy) => {
    const uiEpoch = accountUiEpochRef.current
    setAutoReloadPending(true)
    setAutoReloadFeedback(null)
    try {
      const result = await host.account.saveAutoReload({ policy })
      if (accountUiEpochRef.current !== uiEpoch) return
      if (result.ok) {
        applyAccountSnapshot(result.value)
        if (accountUiEpochRef.current === uiEpoch) {
          setAutoReloadFeedback({ tone: 'success', message: 'Auto-reload settings saved.' })
        }
      } else {
        setAutoReloadPolicy(accountSnapshot.autoReloadPolicy)
        setAutoReloadFeedback(accountErrorFeedback(result.error))
      }
    } finally {
      if (accountUiEpochRef.current === uiEpoch) setAutoReloadPending(false)
    }
  }, [accountSnapshot.autoReloadPolicy, applyAccountSnapshot])

  const currentCheckoutStatusMarker = accountSnapshot.checkoutStatus
    ? checkoutStatusMarker(accountSnapshot.checkoutStatus)
    : ''
  const visibleCheckoutStatus = currentCheckoutStatusMarker
    && currentCheckoutStatusMarker !== dismissedCheckoutStatusMarker
    ? accountSnapshot.checkoutStatus
    : null
  const accountCredits = accountSnapshot.balances
    ? totalCreditMicros(accountSnapshot.balances) / 1_000_000
    : null
  const directProviderAllowed = accountSnapshot.capabilities.directProviderAllowed
  const displayedCredits = directProviderAllowed
    ? apiCredits ?? (accountSnapshot.capabilities.accountConfigured ? 0 : credits)
    : accountCredits ?? 0
  const displayedCreditsLive = directProviderAllowed ? apiCredits != null : accountCredits != null
  const generationReady = directProviderAllowed
    ? apiStatus === 'connected' && apiCredits != null
    : accountSnapshot.capabilities.generationAccess
  const checkoutRecovery = visibleCheckoutStatus
    ? checkoutRecoverySummary(visibleCheckoutStatus)
    : null
  const recoverableScreenState = persistedStateForScreen(screen, activeTool)

  return (
    <div className={`ef-panel ef-panel--${settings.windowMode} ef-panel--screen-${screen}`}>
      <ScreenErrorBoundary
        key={`${screen}:${screen === 'workflow' ? activeTool : ''}`}
        onReturnHome={recoverHome}
        onClearSavedState={recoverableScreenState.length
          ? async () => {
              await Promise.all(recoverableScreenState.map(([namespace, key]) => host.deleteState(namespace, key)))
            }
          : undefined}
      >
      {screen === 'home' && (
        <Home
          navigationMemory={homeNavigationMemoryRef.current}
          settings={settings}
          credits={displayedCredits}
          creditsLive={displayedCreditsLive}
          accountConfigured={accountSnapshot.capabilities.accountConfigured}
          accountReady={generationReady}
          accountSignedIn={accountSignedIn}
          directProviderAllowed={directProviderAllowed}
          apiStatus={apiStatus}
          apiError={apiError}
          hasExistingDirectCredential={hasExistingDirectCredential}
          onConnectApiKey={connectApiKey}
          onAdoptExistingConnection={adoptExistingDirectConnection}
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
          onOpenAccount={() => navigate('account')}
          onOpenSettings={() => navigate('settings')}
          onOpenTool={openToolWorkspace}
          onToggleWindowMode={toggleWindowMode}
          onToggleWindowHeight={toggleWindowHeight}
          windowMode={settings.windowMode}
          windowHeightMode={settings.windowHeightMode}
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
          credits={displayedCredits}
          accountConfigured={accountSnapshot.capabilities.accountConfigured}
          accountReady={generationReady}
          accountSignedIn={accountSignedIn}
          directProviderAllowed={directProviderAllowed}
          hasExistingDirectCredential={hasExistingDirectCredential}
          onBack={goBack}
          onOpenAccount={() => navigate('account')}
          onChange={updateSettings}
          onConnectApiKey={connectApiKey}
          onAdoptExistingConnection={adoptExistingDirectConnection}
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
      {screen === 'account' && (
        <Account
          onBack={goBack}
          session={accountSnapshot.session}
          capabilities={accountSnapshot.capabilities}
          generationReady={generationReady}
          activeJobCount={activeJobCount}
          authMode={accountAuthMode}
          authEmail={accountAuthEmail}
          authPassword={accountAuthPassword}
          authPending={accountAuthPending}
          authFeedback={accountAuthFeedback}
          passwordResetPending={passwordResetPending}
          passwordResetFeedback={passwordResetFeedback}
          passwordRecovery={passwordRecovery}
          passwordRecoveryPending={passwordRecoveryPending}
          passwordRecoveryFeedback={passwordRecoveryFeedback}
          onAuthModeChange={(mode) => {
            setAccountAuthMode(mode)
            setAccountAuthPassword('')
            setAccountAuthFeedback(null)
          }}
          onAuthEmailChange={setAccountAuthEmail}
          onAuthPasswordChange={setAccountAuthPassword}
          onRequestEmailPasswordAuth={requestEmailPasswordAuth}
          onRequestPasswordReset={requestPasswordReset}
          onCompletePasswordRecovery={completePasswordRecovery}
          onCancelPasswordRecovery={cancelPasswordRecovery}
          onRequestGoogleAuth={() => requestSocialAuth('google')}
          onRequestAppleAuth={() => requestSocialAuth('apple')}
          onRequestResendVerification={requestResendVerification}
          verificationPending={verificationPending}
          onRequestSignOut={requestSignOut}
          profilePending={profilePending}
          profileFeedback={profileFeedback}
          onRequestProfileUpdate={requestProfileUpdate}
          accountRefreshPending={accountRefreshPending}
          accountRefreshFeedback={accountRefreshFeedback}
          onRequestRefreshAccount={requestAccountRefresh}
          checkoutStatus={visibleCheckoutStatus}
          checkoutResumePending={checkoutResumePending}
          onRequestResumeCheckout={requestResumeCheckout}
          onDismissCheckoutStatus={() => {
            if (visibleCheckoutStatus?.state === 'completed' || visibleCheckoutStatus?.state === 'closed-unpaid') {
              setDismissedCheckoutStatusMarker(checkoutStatusMarker(visibleCheckoutStatus))
              setAccountRefreshFeedback(null)
            }
          }}
          subscription={accountSnapshot.subscription}
          balances={accountSnapshot.balances}
          selectedPlanId={selectedPlanId}
          billingInterval={billingInterval}
          planCheckoutPending={planCheckoutPending}
          planFeedback={planFeedback}
          onSelectPlan={setSelectedPlanId}
          onBillingIntervalChange={setBillingInterval}
          onRequestPlanCheckout={requestPlanCheckout}
          onRequestBillingPortal={requestBillingPortal}
          partnerEntitlement={accountSnapshot.partnerEntitlement}
          partnerCheckoutPending={partnerCheckoutPending}
          partnerFeedback={partnerFeedback}
          onRequestPartnerCheckout={requestPartnerCheckout}
          topUpCredits={topUpCredits}
          topUpPending={topUpPending}
          topUpFeedback={topUpFeedback}
          onTopUpCreditsChange={setTopUpCredits}
          onRequestTopUpCheckout={requestTopUpCheckout}
          autoReloadPolicy={autoReloadPolicy}
          autoReloadPending={autoReloadPending}
          autoReloadFeedback={autoReloadFeedback}
          onAutoReloadPolicyChange={setAutoReloadPolicy}
          onRequestSaveAutoReload={requestSaveAutoReload}
          privilegedBilling={accountSnapshot.privilegedBilling}
          directProviderCredits={directProviderAllowed ? apiCredits : null}
          upstreamTopUpPending={upstreamTopUpPending}
          upstreamTopUpFeedback={upstreamTopUpFeedback}
          onRequestUpstreamTopUp={requestUpstreamTopUp}
          onOpenSettings={() => navigate('settings')}
          onDisconnectDirectConnection={disconnectDirectConnection}
          directConnectionPresent={hasScopedDirectCredential}
          directConnectionPending={apiStatus === 'connecting'}
        />
      )}
      </ScreenErrorBoundary>

      {screen !== 'account' && accountSignedIn && visibleCheckoutStatus && checkoutRecovery && (
        <button
          type="button"
          className={`ef-account-recovery-notice is-${visibleCheckoutStatus.state}`}
          onClick={() => navigate('account')}
          aria-label={`${checkoutRecovery.title}. ${checkoutRecovery.action}`}
        >
          <span aria-hidden="true">●</span>
          <span><strong>{checkoutRecovery.title}</strong><small>{checkoutRecovery.action} →</small></span>
        </button>
      )}

      <JobCenter onOpenLibrary={() => navigate('library')} bottomInset={screen === 'home' ? 74 : undefined} />
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
