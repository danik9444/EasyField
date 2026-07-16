import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import '../account.css'
import {
  PARTNER_MEMBERSHIP,
  SUBSCRIPTION_PLAN_IDS,
  SUBSCRIPTION_PLANS,
  annualSavingsMoneyMicros,
  minimumTopUpCreditMicros,
  quoteTopUp,
  validateAutoReloadPolicy,
  type AutoReloadPolicy,
  type BillingInterval,
  type CreditMicros,
  type SubscriptionPlanId,
} from '../data/subscriptions'
import {
  formatAccountDate,
  formatCreditMicros,
  formatMoneyMicros,
  hasActivePartnerEntitlement,
  parseWholeCreditInput,
  subscriptionAllowsTopUps,
  totalCreditMicros,
  wholeCreditsFromMicros,
  type AccountAdminBillingSnapshot,
  type AccountAuthMode,
  type AccountCreditBalanceSnapshot,
  type AccountPartnerEntitlementSnapshot,
  type AccountPrivilegedBillingSnapshot,
  type AccountSession,
  type AccountSubscriptionSnapshot,
  type EmailPasswordAuthRequest,
  type PartnerCheckoutRequest,
  type PlanCheckoutRequest,
  type TopUpCheckoutRequest,
} from '../core/account'
import type { AccountCapabilities, AccountCheckoutStatus, AccountPasswordRecoveryCompletion } from '../core/accountBridge'
import { host } from '../services/host'

export interface AccountFeedback {
  tone: 'neutral' | 'success' | 'error'
  message: string
}

export interface AccountProps {
  onBack: () => void
  session: AccountSession
  capabilities: AccountCapabilities
  /** Effective renderer readiness, including a required direct connection. */
  generationReady: boolean
  /** Active work that must finish before session or credential teardown. */
  activeJobCount?: number

  authMode: AccountAuthMode
  authEmail: string
  authPassword: string
  authPending?: boolean
  authFeedback?: AccountFeedback | null
  passwordResetPending?: boolean
  passwordResetFeedback?: AccountFeedback | null
  passwordRecovery?: AccountPasswordRecoveryCompletion | null
  passwordRecoveryPending?: boolean
  passwordRecoveryFeedback?: AccountFeedback | null
  onAuthModeChange: (mode: AccountAuthMode) => void
  onAuthEmailChange: (email: string) => void
  onAuthPasswordChange: (password: string) => void
  onRequestEmailPasswordAuth: (request: EmailPasswordAuthRequest) => void | Promise<void>
  onRequestPasswordReset: (email: string) => void | Promise<void>
  onCompletePasswordRecovery: (attemptId: string, password: string) => void | Promise<void>
  onCancelPasswordRecovery: (attemptId: string) => void | Promise<void>
  onRequestGoogleAuth: () => void | Promise<void>
  onRequestAppleAuth: () => void | Promise<void>
  onRequestResendVerification?: () => void | Promise<void>
  verificationPending?: boolean
  onRequestSignOut: () => void | Promise<void>
  profilePending?: boolean
  profileFeedback?: AccountFeedback | null
  onRequestProfileUpdate: (displayName: string) => void | Promise<void>
  accountRefreshPending?: boolean
  accountRefreshFeedback?: AccountFeedback | null
  onRequestRefreshAccount: () => void | Promise<void>
  checkoutStatus?: AccountCheckoutStatus | null
  checkoutResumePending?: boolean
  onRequestResumeCheckout?: () => void | Promise<void>
  onDismissCheckoutStatus?: () => void

  subscription: AccountSubscriptionSnapshot | null
  balances: AccountCreditBalanceSnapshot | null
  selectedPlanId: SubscriptionPlanId
  billingInterval: BillingInterval
  planCheckoutPending?: boolean
  planFeedback?: AccountFeedback | null
  onSelectPlan: (planId: SubscriptionPlanId) => void
  onBillingIntervalChange: (interval: BillingInterval) => void
  onRequestPlanCheckout: (request: PlanCheckoutRequest) => void | Promise<void>
  onRequestBillingPortal?: () => void | Promise<void>

  /** Commercial entitlement supplied by the trusted account service. */
  partnerEntitlement?: AccountPartnerEntitlementSnapshot | null
  partnerCheckoutPending?: boolean
  partnerFeedback?: AccountFeedback | null
  onRequestPartnerCheckout?: (request: PartnerCheckoutRequest) => void | Promise<void>

  topUpCredits: string
  topUpPending?: boolean
  topUpFeedback?: AccountFeedback | null
  onTopUpCreditsChange: (value: string) => void
  onRequestTopUpCheckout: (request: TopUpCheckoutRequest) => void | Promise<void>

  autoReloadPolicy: AutoReloadPolicy
  autoReloadPending?: boolean
  autoReloadFeedback?: AccountFeedback | null
  onAutoReloadPolicyChange: (policy: AutoReloadPolicy) => void
  onRequestSaveAutoReload: (policy: AutoReloadPolicy) => void | Promise<void>

  /** Returned only by a privileged endpoint for an admin or active Partner. */
  privilegedBilling?: AccountPrivilegedBillingSnapshot | null
  /** Locally verified live balance fallback for this privileged direct connection. */
  directProviderCredits?: number | null
  /** @deprecated Compatibility alias for existing admin integrations. */
  adminBilling?: AccountAdminBillingSnapshot | null
  upstreamTopUpPending?: boolean
  upstreamTopUpFeedback?: AccountFeedback | null
  onRequestUpstreamTopUp?: () => void | Promise<void>
  /** Optional navigation handoff to the app's connection settings. */
  onOpenSettings?: () => void
  /** Optional Main-backed removal of the current account-scoped direct connection. */
  onDisconnectDirectConnection?: () => void | Promise<void>
  /** True when an account-scoped credential exists, even if its balance is unavailable. */
  directConnectionPresent?: boolean
  directConnectionPending?: boolean
}

const STATUS_LABELS: Record<AccountSubscriptionSnapshot['status'], string> = {
  active: 'Active',
  trialing: 'Trial',
  'past-due': 'Past due',
  paused: 'Paused',
  canceled: 'Canceled',
  expired: 'Expired',
  incomplete: 'Needs setup',
}

type AccountSection = 'overview' | 'profile' | 'billing' | 'credits' | 'security' | 'connections'

const ACCOUNT_SECTIONS: ReadonlyArray<{
  id: AccountSection
  label: string
  detail: string
  icon: string
  eyebrow: string
  title: string
  description: string
}> = [
  { id: 'overview', label: 'Overview', detail: 'Access at a glance', icon: '◫', eyebrow: 'ACCOUNT', title: 'Your EasyField workspace', description: 'Review access, credits and the actions that need your attention.' },
  { id: 'profile', label: 'Profile', detail: 'Identity details', icon: '◎', eyebrow: 'PROFILE', title: 'Personal details', description: 'The verified identity attached to your projects, access and purchases.' },
  { id: 'billing', label: 'Plan & Billing', detail: 'Membership', icon: '◇', eyebrow: 'MEMBERSHIP', title: 'Plan and billing', description: 'Review your current access and manage the membership that fits your work.' },
  { id: 'credits', label: 'Credits', detail: 'Balance & top-ups', icon: '＋', eyebrow: 'USAGE', title: 'Credits and usage', description: 'See what is available, what expires and how additional credits are purchased.' },
  { id: 'security', label: 'Security', detail: 'Verification & session', icon: '◌', eyebrow: 'SECURITY', title: 'Account security', description: 'Review verification and control the active EasyField session on this Mac.' },
  { id: 'connections', label: 'Connections', detail: 'Account & runtime', icon: '⌁', eyebrow: 'CONNECTIONS', title: 'Connected services', description: 'See which trusted services and local runtime are available to this account.' },
]

function roleLabel(session: Extract<AccountSession, { status: 'signed-in' }>, activePartner: boolean): string {
  if (session.platformRole === 'admin') return 'Admin'
  if (activePartner) return 'Partner · Lifetime'
  if (session.platformRole === 'support') return 'Support'
  return 'Customer'
}

function providerCreditLabel(props: Pick<AccountProps, 'privilegedBilling' | 'adminBilling' | 'directProviderCredits'>): string {
  const snapshot = props.privilegedBilling ?? props.adminBilling
  if (snapshot?.upstreamBalanceCreditMicros != null) return formatCreditMicros(snapshot.upstreamBalanceCreditMicros)
  if (typeof props.directProviderCredits === 'number' && Number.isFinite(props.directProviderCredits) && props.directProviderCredits >= 0) {
    return props.directProviderCredits.toLocaleString('en-US')
  }
  return '—'
}

function Feedback({ value }: { value?: AccountFeedback | null }) {
  return (
    <div className={`ef-account-feedback${value ? ` is-${value.tone}` : ''}`} aria-live="polite">
      {value?.message ?? ''}
    </div>
  )
}

function AuthView(props: AccountProps) {
  const emailId = useId()
  const passwordId = useId()
  const signUp = props.authMode === 'sign-up'
  const serviceUnavailable = !props.capabilities.accountConfigured
  const configuredOAuthProviders = Array.isArray(props.capabilities.oauthProviders)
    ? props.capabilities.oauthProviders
    : []
  const googleOAuthAvailable = configuredOAuthProviders.includes('google')
  const appleOAuthAvailable = configuredOAuthProviders.includes('apple')
  const socialAuthAvailable = googleOAuthAvailable || appleOAuthAvailable

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void props.onRequestEmailPasswordAuth({
      mode: props.authMode,
      email: props.authEmail.trim(),
      password: props.authPassword,
    })
  }

  return (
    <main className="ef-account-auth ef-scroll">
      <section className="ef-account-auth-card" aria-labelledby="ef-account-auth-title">
        <div className="ef-account-auth-mark" aria-hidden="true">EF</div>
        <div className="ef-account-auth-intro">
          <span>YOUR EASYFIELD ACCOUNT</span>
          <h1 id="ef-account-auth-title">{signUp ? 'Create your workspace account.' : 'Welcome back.'}</h1>
          <p>{signUp ? 'Keep plans, credits and billing controls tied to one verified identity.' : 'Sign in to review credits, plans and account settings.'}</p>
        </div>

        {serviceUnavailable && (
          <div className="ef-account-feedback is-error" role="alert">
            EasyField Account is unavailable because the account service is not configured in this build.
          </div>
        )}

        <div className="ef-account-auth-tabs" role="group" aria-label="Account access">
          <button type="button" aria-pressed={!signUp} onClick={() => props.onAuthModeChange('sign-in')}>Sign in</button>
          <button type="button" aria-pressed={signUp} onClick={() => props.onAuthModeChange('sign-up')}>Create account</button>
        </div>

        <form className="ef-account-auth-form" onSubmit={submit}>
          <label htmlFor={emailId}>Email address</label>
          <input
            id={emailId}
            type="email"
            value={props.authEmail}
            autoComplete="email"
            placeholder="editor@studio.com"
            onChange={(event) => props.onAuthEmailChange(event.target.value)}
            disabled={props.authPending || serviceUnavailable}
            required
          />
          <label htmlFor={passwordId}>Password</label>
          <input
            id={passwordId}
            type="password"
            value={props.authPassword}
            autoComplete={signUp ? 'new-password' : 'current-password'}
            placeholder={signUp ? 'Create a secure password' : 'Enter your password'}
            onChange={(event) => props.onAuthPasswordChange(event.target.value)}
            disabled={props.authPending || serviceUnavailable}
            minLength={signUp ? 8 : undefined}
            aria-describedby={signUp ? `${passwordId}-help` : undefined}
            required
          />
          {signUp && <p id={`${passwordId}-help`} className="ef-account-password-help">Use at least 8 characters.</p>}
          {!signUp && (
            <button
              type="button"
              className="ef-account-reset"
              disabled={props.authPending || props.passwordResetPending || serviceUnavailable}
              onClick={() => void props.onRequestPasswordReset(props.authEmail.trim())}
            >
              {props.passwordResetPending ? 'Sending reset email…' : 'Forgot password?'}
            </button>
          )}
          {signUp && <p className="ef-account-verification-note"><span aria-hidden="true">✉</span>Email verification is required before paid actions are available.</p>}
          <button className="ef-account-primary" type="submit" disabled={props.authPending || serviceUnavailable}>
            {props.authPending ? 'Please wait…' : signUp ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <Feedback value={props.authFeedback} />
        <Feedback value={props.passwordResetFeedback} />

        {socialAuthAvailable && (
          <>
            <div className="ef-account-divider"><span>or continue with</span></div>
            <div className="ef-account-socials">
              {googleOAuthAvailable && (
                <button type="button" onClick={() => void props.onRequestGoogleAuth()} disabled={props.authPending || serviceUnavailable}><b aria-hidden="true">G</b>Google</button>
              )}
              {appleOAuthAvailable && (
                <button type="button" onClick={() => void props.onRequestAppleAuth()} disabled={props.authPending || serviceUnavailable}><b aria-hidden="true">●</b>Apple</button>
              )}
            </div>
          </>
        )}
        <p className="ef-account-auth-footnote">Authentication and billing results appear only after the account service confirms them.</p>
      </section>
    </main>
  )
}

function PasswordRecoveryView(props: AccountProps & { recovery: AccountPasswordRecoveryCompletion }) {
  const passwordId = useId()
  const confirmId = useId()
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const mismatch = confirmation.length > 0 && password !== confirmation
  const valid = password.length >= 8 && password === confirmation

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!valid || props.passwordRecoveryPending) return
    void props.onCompletePasswordRecovery(props.recovery.attemptId, password)
  }

  return (
    <main className="ef-account-auth ef-scroll">
      <section className="ef-account-auth-card ef-account-recovery-card" aria-labelledby="ef-password-recovery-title">
        <div className="ef-account-auth-mark" aria-hidden="true">↻</div>
        <div className="ef-account-auth-intro">
          <span>SECURE PASSWORD RECOVERY</span>
          <h1 id="ef-password-recovery-title">Choose a new password.</h1>
          <p>The recovery link was verified in your browser. The temporary recovery session remains protected by EasyField on this Mac.</p>
        </div>
        <form className="ef-account-auth-form" onSubmit={submit}>
          <label htmlFor={passwordId}>New password</label>
          <input id={passwordId} type="password" autoComplete="new-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} disabled={props.passwordRecoveryPending} required />
          <label htmlFor={confirmId}>Confirm new password</label>
          <input id={confirmId} type="password" autoComplete="new-password" minLength={8} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={props.passwordRecoveryPending} aria-invalid={mismatch || undefined} required />
          <p className={`ef-account-password-help${mismatch ? ' is-error' : ''}`}>{mismatch ? 'Passwords do not match.' : 'Use at least 8 characters.'}</p>
          <div className="ef-account-recovery-actions">
            <button type="button" className="ef-account-secondary" disabled={props.passwordRecoveryPending} onClick={() => void props.onCancelPasswordRecovery(props.recovery.attemptId)}>Cancel</button>
            <button type="submit" className="ef-account-primary" disabled={!valid || props.passwordRecoveryPending} aria-busy={props.passwordRecoveryPending || undefined}>{props.passwordRecoveryPending ? 'Updating…' : 'Update password'}</button>
          </div>
        </form>
        <Feedback value={props.passwordRecoveryFeedback} />
      </section>
    </main>
  )
}

function AccountHeader({
  onBack,
}: Pick<AccountProps, 'onBack'>) {
  return (
    <header className="ef-account-header">
      <button type="button" className="ef-account-back" onClick={onBack} aria-label="Back">←</button>
      <div className="ef-account-heading">
        <span>ACCOUNT</span>
        <h1>EasyField account</h1>
      </div>
    </header>
  )
}

function CheckoutRecoverySection({
  checkoutStatus,
  checkoutResumePending,
  onRequestResumeCheckout,
  accountRefreshPending,
  accountRefreshFeedback,
  onRequestRefreshAccount,
  onDismissCheckoutStatus,
}: Pick<AccountProps, 'checkoutStatus' | 'checkoutResumePending' | 'onRequestResumeCheckout' | 'accountRefreshPending' | 'accountRefreshFeedback' | 'onRequestRefreshAccount' | 'onDismissCheckoutStatus'>) {
  if (!checkoutStatus) return null
  const kindLabel = checkoutStatus.kind === 'subscription'
    ? 'Plan'
    : checkoutStatus.kind === 'top-up'
      ? 'Credit top-up'
      : 'Partner'
  const canResume = checkoutStatus.state === 'pending' || checkoutStatus.state === 'ready-to-resume'
  const title = checkoutStatus.state === 'ready-to-resume'
    ? `${kindLabel} checkout is ready to resume`
    : checkoutStatus.state === 'pending'
      ? `${kindLabel} checkout is open`
      : checkoutStatus.state === 'awaiting-reconciliation'
        ? `We’re still checking this ${kindLabel.toLowerCase()} checkout`
        : checkoutStatus.state === 'completed'
          ? `${kindLabel} payment confirmed`
          : `${kindLabel} checkout closed without payment`
  const description = checkoutStatus.state === 'ready-to-resume'
    ? 'Continue the same protected checkout. EasyField will reopen it instead of creating another purchase.'
    : checkoutStatus.state === 'pending'
      ? 'Finish or reopen your existing checkout. Credits or access update only after payment is confirmed.'
      : checkoutStatus.state === 'awaiting-reconciliation'
        ? 'We could not verify the final result yet. Another purchase stays paused until this checkout is confirmed or closed.'
        : checkoutStatus.state === 'completed'
          ? 'Your account access and credits now reflect the confirmed payment.'
          : 'No payment was captured. You can start a new checkout when you are ready.'
  return (
    <section className={`ef-account-refresh ef-account-checkout-recovery is-${checkoutStatus.state}`} aria-live="polite">
      <div><strong>{title}</strong><p>{description}</p></div>
      {canResume && onRequestResumeCheckout && (
          <button
            type="button"
            disabled={checkoutResumePending}
            aria-busy={checkoutResumePending || undefined}
            onClick={() => void onRequestResumeCheckout()}
        >{checkoutResumePending ? 'Reopening…' : checkoutStatus.state === 'pending' ? 'Reopen checkout' : 'Resume checkout'}</button>
      )}
      {checkoutStatus.state === 'awaiting-reconciliation' && (
          <button
            type="button"
            disabled={accountRefreshPending}
            aria-busy={accountRefreshPending || undefined}
            onClick={() => void onRequestRefreshAccount()}
        >{accountRefreshPending ? 'Checking…' : 'Check payment status'}</button>
      )}
      {(checkoutStatus.state === 'completed' || checkoutStatus.state === 'closed-unpaid') && onDismissCheckoutStatus && (
        <button type="button" onClick={onDismissCheckoutStatus}>Done</button>
      )}
      {accountRefreshFeedback && <Feedback value={accountRefreshFeedback} />}
    </section>
  )
}

function BalanceSection({ balances, subscription }: Pick<AccountProps, 'balances' | 'subscription'>) {
  const total = balances ? formatCreditMicros(totalCreditMicros(balances)) : '—'
  return (
    <section className="ef-account-section ef-account-balance-section" aria-labelledby="ef-account-balance-title">
      <div className="ef-account-section-title">
        <div><span>AVAILABLE BALANCE</span><h2 id="ef-account-balance-title">Know which credits expire.</h2></div>
        <div className="ef-account-total"><small>Total credits</small><strong>{total}</strong></div>
      </div>
      <div className="ef-account-balance-grid">
        <article className="ef-account-balance-card is-subscription">
          <span className="ef-account-balance-icon" aria-hidden="true">↻</span>
          <div><small>SUBSCRIPTION CREDITS</small><strong>{balances ? formatCreditMicros(balances.subscriptionCreditMicros) : '—'}</strong></div>
          <p>{balances?.subscriptionExpiresAtMs ? `Expires ${formatAccountDate(balances.subscriptionExpiresAtMs)}` : subscription ? 'Expiration date unavailable' : 'Available with an active plan'}</p>
        </article>
        <article className="ef-account-balance-card is-purchased">
          <span className="ef-account-balance-icon" aria-hidden="true">＋</span>
          <div><small>PURCHASED CREDITS</small><strong>{balances ? formatCreditMicros(balances.purchasedCreditMicros) : '—'}</strong></div>
          <p>Purchased credits do not expire.</p>
        </article>
        {balances && balances.otherCreditMicros > 0 && (
          <article className="ef-account-balance-card is-other">
            <span className="ef-account-balance-icon" aria-hidden="true">◇</span>
            <div><small>OTHER CREDITS</small><strong>{formatCreditMicros(balances.otherCreditMicros)}</strong></div>
            <p>Additional credits granted to this account.</p>
          </article>
        )}
      </div>
      {balances && <small className="ef-account-measured">Balance updated {formatAccountDate(balances.measuredAtMs)}</small>}
    </section>
  )
}

function PlansSection(props: AccountProps & { billingLocked: boolean; portalLocked: boolean; managedSubscription: boolean }) {
  const descriptionId = useId()
  const selectedPlan = SUBSCRIPTION_PLANS[props.selectedPlanId]
  const selectedCharge = props.billingInterval === 'annual'
    ? selectedPlan.annualChargeMoneyMicros
    : selectedPlan.monthlyChargeMoneyMicros
  const currentExact = subscriptionAllowsTopUps(props.subscription)
    && props.subscription.planId === props.selectedPlanId
    && props.subscription.billingInterval === props.billingInterval
    && !props.subscription.cancelAtPeriodEnd

  return (
    <section className="ef-account-section ef-account-plans" aria-labelledby="ef-account-plans-title" aria-describedby={descriptionId}>
      <div className="ef-account-section-title ef-account-plans-head">
        <div><span>MEMBERSHIP</span><h2 id="ef-account-plans-title">Choose the pace that fits your work.</h2><p id={descriptionId}>Credits refresh monthly. Annual plans are paid once for the year, while credits are released in monthly windows.</p></div>
        <div className="ef-account-interval" role="group" aria-label="Billing interval">
          <button type="button" aria-pressed={props.billingInterval === 'monthly'} onClick={() => props.onBillingIntervalChange('monthly')}>
            <span>Monthly</span><small>Pay each month</small>
          </button>
          <button type="button" aria-pressed={props.billingInterval === 'annual'} onClick={() => props.onBillingIntervalChange('annual')}>
            <span>Annual</span><small>Pay once a year</small>
          </button>
        </div>
      </div>

      {props.subscription && (
        <div className={`ef-account-current is-${props.subscription.status}`}>
          <div><span>CURRENT</span><strong>{SUBSCRIPTION_PLANS[props.subscription.planId].name} · {STATUS_LABELS[props.subscription.status]}</strong></div>
          <p>{props.subscription.currentPeriodEndMs ? `${props.subscription.cancelAtPeriodEnd ? 'Ends' : 'Renews'} ${formatAccountDate(props.subscription.currentPeriodEndMs)}` : 'Billing date unavailable'}</p>
          {props.onRequestBillingPortal && <button type="button" disabled={props.planCheckoutPending || props.portalLocked} aria-busy={props.planCheckoutPending || undefined} onClick={() => void props.onRequestBillingPortal?.()}>Manage billing</button>}
        </div>
      )}

      <div className="ef-account-plan-grid" role="group" aria-label="Subscription plans">
        {SUBSCRIPTION_PLAN_IDS.map((planId) => {
          const plan = SUBSCRIPTION_PLANS[planId]
          const selected = props.selectedPlanId === planId
          const price = props.billingInterval === 'annual' ? plan.annualMonthlyEquivalentMoneyMicros : plan.monthlyChargeMoneyMicros
          const annualSaving = annualSavingsMoneyMicros(planId)
          const current = props.subscription?.planId === planId
          const billingSummary = props.billingInterval === 'annual'
            ? `${formatMoneyMicros(plan.annualChargeMoneyMicros)} billed yearly${annualSaving > 0 ? `, save ${formatMoneyMicros(annualSaving)}` : ''}`
            : `${formatMoneyMicros(plan.monthlyChargeMoneyMicros)} billed monthly`
          const accessibleLabel = `${plan.name}. ${formatMoneyMicros(price)} per month. ${billingSummary}. ${formatCreditMicros(plan.monthlyGrantCreditMicros)} credits each month.${selected ? ' Selected.' : ''}`
          return (
            <button
              type="button"
              aria-pressed={selected}
              aria-label={accessibleLabel}
              className={`ef-account-plan${selected ? ' is-selected' : ''}`}
              key={planId}
              onClick={() => props.onSelectPlan(planId)}
            >
              <span className="ef-account-plan-top"><span className="ef-account-plan-name"><i className="ef-account-plan-choice" aria-hidden="true" /><b>{plan.name}</b></span>{current && <i>CURRENT</i>}</span>
              <span className="ef-account-plan-price"><strong>{formatMoneyMicros(price)}</strong><small>/ month{props.billingInterval === 'annual' ? ' equivalent' : ''}</small></span>
              {props.billingInterval === 'annual'
                ? <span className="ef-account-plan-billing">{formatMoneyMicros(plan.annualChargeMoneyMicros)} billed yearly{annualSaving > 0 && <> · save {formatMoneyMicros(annualSaving)}</>}</span>
                : <span className="ef-account-plan-billing">Billed monthly</span>}
              <span className="ef-account-plan-rule" />
              <span className="ef-account-plan-fact"><i aria-hidden="true">✓</i><span><b>{formatCreditMicros(plan.monthlyGrantCreditMicros)}</b> credits each month</span></span>
              <span className="ef-account-plan-fact"><i aria-hidden="true">✓</i><span>Top-ups at {formatMoneyMicros(plan.topUpMoneyMicrosPerCredit, { minimumFractionDigits: 3, maximumFractionDigits: 3 })} / credit</span></span>
              <span className="ef-account-plan-fact ef-account-model-access"><i aria-hidden="true">✓</i><span>{plan.modelAccessNote}</span></span>
              <span className="ef-account-plan-select">{selected ? 'Selected' : 'Select plan'}<i aria-hidden="true">→</i></span>
            </button>
          )
        })}
      </div>

      <div className="ef-account-checkout-row">
        <div className="ef-account-checkout-selection"><small>{props.managedSubscription ? 'PLAN MANAGEMENT' : 'SELECTED PLAN'}</small><strong>{props.managedSubscription && props.subscription ? `${SUBSCRIPTION_PLANS[props.subscription.planId].name} · ${STATUS_LABELS[props.subscription.status]}` : `${selectedPlan.name} · ${props.billingInterval === 'annual' ? 'Annual' : 'Monthly'}`}</strong></div>
        <div className="ef-account-checkout-due"><small>{props.managedSubscription ? 'NEXT STEP' : 'DUE AT CHECKOUT'}</small><strong>{props.managedSubscription ? 'Secure billing portal' : formatMoneyMicros(selectedCharge)}</strong></div>
        <button
          type="button"
          className="ef-account-primary"
          disabled={props.planCheckoutPending || (props.managedSubscription ? props.portalLocked || !props.onRequestBillingPortal : props.billingLocked || currentExact)}
          aria-busy={props.planCheckoutPending || undefined}
          onClick={() => void (props.managedSubscription
            ? props.onRequestBillingPortal?.()
            : props.onRequestPlanCheckout({ planId: props.selectedPlanId, billingInterval: props.billingInterval }))}
        >
          {props.planCheckoutPending ? 'Opening…' : props.managedSubscription ? 'Manage current plan' : currentExact ? 'Current plan' : `Review ${selectedPlan.name} checkout`}
        </button>
      </div>
      {props.managedSubscription && <p className="ef-account-field-help">Plan changes and cancellation are handled through Manage billing.</p>}
      <Feedback value={props.planFeedback} />
    </section>
  )
}

function PartnerMembershipSection(props: AccountProps & { billingLocked: boolean; activePartner: boolean }) {
  const product = PARTNER_MEMBERSHIP
  const checkoutUnavailable = !props.onRequestPartnerCheckout
  const checkoutLockMessage = !props.capabilities.partnerCheckoutAvailable
    ? 'Partner purchase is temporarily unavailable. Please try again later.'
    : props.session.status === 'signed-in' && !props.session.emailVerified
      ? 'Verify your email before purchasing Partner access.'
      : 'Finish or close the current checkout before starting another purchase.'

  return (
    <section className={`ef-account-section ef-account-partner${props.activePartner ? ' is-active' : ''}`} aria-labelledby="ef-account-partner-title">
      <div className="ef-account-partner-copy">
        <span>ONE-TIME MEMBERSHIP</span>
        <div className="ef-account-partner-title-row">
          <h2 id="ef-account-partner-title">Partner</h2>
          {props.activePartner && <i>ACTIVE · LIFETIME</i>}
        </div>
        <p>Own lifetime access to EasyField and work with every verified model. Credits are purchased separately and no credits are included in the membership.</p>
        <div className="ef-account-partner-facts" aria-label="Partner membership benefits">
          <span><b>All models</b><small>Every verified model family is available.</small></span>
          <span><b>{formatMoneyMicros(product.directCreditMoneyMicrosPerCredit, { minimumFractionDigits: 3, maximumFractionDigits: 3 })} / credit</b><small>Direct credit reference rate.</small></span>
          <span><b>No monthly fee</b><small>One payment, lifetime access.</small></span>
        </div>
      </div>
      <div className="ef-account-partner-purchase">
        <span className="ef-account-partner-price"><strong>{formatMoneyMicros(product.oneTimeChargeMoneyMicros)}</strong><small>one time</small></span>
        {props.activePartner ? (
          <span className="ef-account-partner-owned" role="status">Partner access is active</span>
        ) : (
          <button
            type="button"
            className="ef-account-primary"
            disabled={props.partnerCheckoutPending || props.billingLocked || checkoutUnavailable}
            aria-busy={props.partnerCheckoutPending || undefined}
            title={checkoutUnavailable || props.billingLocked ? checkoutLockMessage : undefined}
            onClick={() => void props.onRequestPartnerCheckout?.({ productId: product.id })}
          >
            {props.partnerCheckoutPending ? 'Opening checkout…' : 'Get lifetime access'}
          </button>
        )}
        {!props.activePartner && props.billingLocked && <small className="ef-account-field-help">{checkoutLockMessage}</small>}
      </div>
      <Feedback value={props.partnerFeedback} />
    </section>
  )
}

function TopUpSection(props: AccountProps & { billingLocked: boolean; pricingPlanId: SubscriptionPlanId; hasEligiblePlan: boolean }) {
  const inputId = useId()
  const parsed = parseWholeCreditInput(props.topUpCredits)
  const quote = parsed.ok ? quoteTopUp(props.pricingPlanId, parsed.amountCreditMicros) : null
  const plan = SUBSCRIPTION_PLANS[props.pricingPlanId]
  const minimumCredits = wholeCreditsFromMicros(minimumTopUpCreditMicros(props.pricingPlanId))
  const hasInput = props.topUpCredits.trim().length > 0
  const validation = !hasInput
    ? null
    : !parsed.ok
      ? 'Enter a positive whole number of credits.'
    : !quote?.meetsMinimum
      ? `The minimum top-up is $10 (${minimumCredits.toLocaleString('en-US')} credits on ${plan.name}).`
      : null
  const help = validation ?? (parsed.ok
    ? `${parsed.wholeCredits.toLocaleString('en-US')} credits · ${plan.name} plan rate`
    : `Enter at least ${minimumCredits.toLocaleString('en-US')} whole credits.`)

  const requestTopUp = () => {
    if (!parsed.ok || !quote?.meetsMinimum) return
    void props.onRequestTopUpCheckout({
      planId: props.pricingPlanId,
      amountCreditMicros: parsed.amountCreditMicros,
    })
  }

  return (
    <section className="ef-account-section ef-account-topup" aria-labelledby="ef-account-topup-title">
      <div className="ef-account-section-title">
        <div><span>NON-EXPIRING CREDITS</span><h2 id="ef-account-topup-title">Top up when a project needs more.</h2><p>The live checkout service must confirm the final charge before payment.</p></div>
        <span className="ef-account-rate">{plan.name} rate · {formatMoneyMicros(plan.topUpMoneyMicrosPerCredit, { minimumFractionDigits: 3, maximumFractionDigits: 3 })}/credit</span>
      </div>
      {!props.hasEligiblePlan && <p className="ef-account-plan-required" role="status">Choose and activate a plan before buying extra credits. Your active plan sets the top-up rate.</p>}
      <div className="ef-account-topup-row">
        <label htmlFor={inputId}><span>Credits to add</span><input id={inputId} type="text" inputMode="numeric" pattern="[0-9,]*" autoComplete="off" value={props.topUpCredits} onChange={(event) => props.onTopUpCreditsChange(event.target.value)} aria-describedby="ef-account-topup-help" aria-invalid={Boolean(validation) || undefined} placeholder={minimumCredits.toLocaleString('en-US')} disabled={props.topUpPending} /></label>
        <div className="ef-account-quote" role="status" aria-live="polite"><small>ESTIMATED CHARGE</small><strong>{quote ? formatMoneyMicros(quote.chargeMoneyMicros) : '—'}</strong><span>$10 minimum</span></div>
        <button type="button" className="ef-account-primary" disabled={!parsed.ok || Boolean(validation) || props.topUpPending || props.billingLocked} aria-busy={props.topUpPending || undefined} onClick={requestTopUp}>{props.topUpPending ? 'Opening checkout…' : 'Review top-up'}</button>
      </div>
      <p id="ef-account-topup-help" className={`ef-account-field-help${validation ? ' is-error' : ''}`} aria-live="polite">{help}</p>
      <Feedback value={props.topUpFeedback} />
    </section>
  )
}

function microsFromWholeCredits(value: number): CreditMicros {
  if (!Number.isFinite(value) || value < 0) return 0
  const micros = Math.floor(value) * 1_000_000
  return Number.isSafeInteger(micros) ? micros : 0
}

function AutoReloadSection(props: AccountProps & { billingLocked: boolean; pricingPlanId: SubscriptionPlanId; hasEligiblePlan: boolean }) {
  const policy = props.autoReloadPolicy
  const minimumCredits = wholeCreditsFromMicros(minimumTopUpCreditMicros(props.pricingPlanId))
  const errors = validateAutoReloadPolicy(props.pricingPlanId, policy)
  const enable = () => props.onAutoReloadPolicyChange({
    enabled: true,
    triggerBalanceCreditMicros: 0,
    topUpAmountCreditMicros: minimumTopUpCreditMicros(props.pricingPlanId),
  })
  const disable = () => {
    const disabledPolicy = { enabled: false } as const
    props.onAutoReloadPolicyChange(disabledPolicy)
    void props.onRequestSaveAutoReload(disabledPolicy)
  }

  return (
    <section className="ef-account-section ef-account-autoreload" aria-labelledby="ef-account-autoreload-title">
      <div className="ef-account-autoreload-head">
        <div className="ef-account-autoreload-icon" aria-hidden="true">↻</div>
        <div><span>OPTIONAL</span><h2 id="ef-account-autoreload-title">Auto-reload</h2><p>Request a non-expiring top-up when your available balance falls below your threshold.</p></div>
        <button
          type="button"
          role="switch"
          aria-label={policy.enabled ? 'Turn off auto-reload' : 'Turn on auto-reload'}
          aria-checked={policy.enabled}
          className="ef-account-switch"
          disabled={props.autoReloadPending || (!policy.enabled && (props.billingLocked || !props.hasEligiblePlan))}
          onClick={() => policy.enabled ? disable() : enable()}
        ><span /></button>
      </div>
      {policy.enabled && (
        <div className="ef-account-autoreload-controls">
          <label><span>When balance is below</span><div><input type="number" min="0" step="1" value={wholeCreditsFromMicros(policy.triggerBalanceCreditMicros)} onChange={(event) => props.onAutoReloadPolicyChange({ ...policy, triggerBalanceCreditMicros: microsFromWholeCredits(event.target.valueAsNumber) })} /><small>credits</small></div></label>
          <span className="ef-account-flow" aria-hidden="true">→</span>
          <label><span>Add</span><div><input type="number" min={minimumCredits} step="1" value={wholeCreditsFromMicros(policy.topUpAmountCreditMicros)} onChange={(event) => props.onAutoReloadPolicyChange({ ...policy, topUpAmountCreditMicros: microsFromWholeCredits(event.target.valueAsNumber) })} /><small>credits</small></div></label>
          <button type="button" onClick={() => void props.onRequestSaveAutoReload(policy)} disabled={props.autoReloadPending || props.billingLocked || errors.length > 0}>{props.autoReloadPending ? 'Saving…' : 'Save auto-reload'}</button>
        </div>
      )}
      {!props.hasEligiblePlan && <p className="ef-account-field-help">Auto-reload becomes available after a plan is active.</p>}
      {policy.enabled && errors.length > 0 && <p className="ef-account-field-help is-error">Top-up amount must meet the $10 minimum ({minimumCredits.toLocaleString('en-US')} credits).</p>}
      <Feedback value={props.autoReloadFeedback} />
    </section>
  )
}

function PrivilegedBillingSection({
  session,
  directProviderAllowed,
  privilegedBilling,
  adminBilling,
  directProviderCredits,
  upstreamTopUpPending,
  upstreamTopUpFeedback,
  onRequestUpstreamTopUp,
}: Pick<AccountProps, 'session' | 'privilegedBilling' | 'adminBilling' | 'directProviderCredits' | 'upstreamTopUpPending' | 'upstreamTopUpFeedback' | 'onRequestUpstreamTopUp'> & { directProviderAllowed: boolean }) {
  const snapshot = privilegedBilling ?? adminBilling
  if (session.status !== 'signed-in' || !session.emailVerified || !directProviderAllowed) return null
  const localBalance = typeof directProviderCredits === 'number' && Number.isFinite(directProviderCredits) && directProviderCredits >= 0
    ? directProviderCredits
    : null
  const providerBalance = snapshot?.upstreamBalanceCreditMicros == null
    ? localBalance == null ? 'Unavailable' : `${localBalance.toLocaleString('en-US')} credits`
    : `${formatCreditMicros(snapshot.upstreamBalanceCreditMicros)} credits`
  const admin = session.status === 'signed-in' && session.platformRole === 'admin'
  const canOpenUpstreamTopUp = Boolean(onRequestUpstreamTopUp) || host.isPlugin()
  const requestUpstreamTopUp = () => {
    if (onRequestUpstreamTopUp) return onRequestUpstreamTopUp()
    return host.openCreditPurchase()
  }
  return (
    <section className="ef-account-section ef-account-admin" aria-labelledby="ef-account-admin-title">
      <div className="ef-account-admin-head">
        <span aria-hidden="true">◆</span>
        <div>
          <small>{admin ? 'ADMIN DIRECT ACCESS' : 'PARTNER DIRECT ACCESS'}</small>
          <h2 id="ef-account-admin-title">Direct provider billing</h2>
          <p>Raw provider balance and cost are visible only to this privileged account.</p>
        </div>
        {canOpenUpstreamTopUp && (
          <button
            type="button"
            className="ef-account-primary ef-account-provider-topup"
            disabled={upstreamTopUpPending}
            onClick={() => void requestUpstreamTopUp()}
          >{upstreamTopUpPending ? 'Opening…' : 'Buy provider credits'}</button>
        )}
      </div>
      <div className="ef-account-admin-grid">
        <div><small>PROVIDER BALANCE</small><strong>{providerBalance}</strong></div>
        <div><small>LATEST RAW COST</small><strong>{snapshot?.latestRawCostMoneyMicros == null || !snapshot.latestRawCostCurrencyCode ? 'Unavailable' : formatMoneyMicros(snapshot.latestRawCostMoneyMicros, { currency: snapshot.latestRawCostCurrencyCode, minimumFractionDigits: 2, maximumFractionDigits: 6 })}</strong></div>
        <div><small>DIRECT RATE</small><strong>{formatMoneyMicros(PARTNER_MEMBERSHIP.directCreditMoneyMicrosPerCredit, { minimumFractionDigits: 3, maximumFractionDigits: 3 })} / credit</strong></div>
        <div><small>MEASURED</small><strong>{snapshot ? formatAccountDate(snapshot.measuredAtMs) : 'Unavailable'}</strong></div>
      </div>
      <Feedback value={upstreamTopUpFeedback} />
    </section>
  )
}

function AccountNavigation({
  session,
  activePartner,
  section,
  authPending,
  onSectionChange,
  onRequestSignOut,
  activeJobCount = 0,
}: {
  session: Extract<AccountSession, { status: 'signed-in' }>
  activePartner: boolean
  section: AccountSection
  authPending?: boolean
  onSectionChange: (section: AccountSection) => void
  onRequestSignOut: () => void | Promise<void>
  activeJobCount?: number
}) {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
    const expanded = window.matchMedia?.('(min-width: 700px)').matches === true
    const delta = expanded
      ? event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1
      : event.key === 'ArrowDown' ? 3 : event.key === 'ArrowUp' ? -3 : event.key === 'ArrowRight' ? 1 : -1
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (index + delta + buttons.length) % buttons.length
    const next = ACCOUNT_SECTIONS[nextIndex]
    if (!next) return
    onSectionChange(next.id)
    buttons[nextIndex]?.focus()
  }

  const displayName = session.displayName?.trim() || 'EasyField account'
  const accessLabel = session.platformRole === 'admin'
    ? 'Admin direct access'
    : session.platformRole === 'support'
      ? 'Support access'
    : activePartner
      ? 'Partner direct access'
      : 'Plans & credits'
  return (
    <nav className="ef-account-nav" aria-label="Account navigation">
      <div className="ef-account-nav-identity">
        <span aria-hidden="true">{displayName === 'EasyField account' ? session.email.slice(0, 1).toUpperCase() : displayName.slice(0, 1).toUpperCase()}</span>
        <div><strong>{displayName}</strong><small title={session.email}>{session.email}</small><i>{accessLabel}</i></div>
      </div>
      <div className="ef-account-nav-items" role="tablist" aria-label="Account sections">
        {ACCOUNT_SECTIONS.map((item, index) => (
          <button
            type="button"
            role="tab"
            id={`ef-account-tab-${item.id}`}
            aria-selected={section === item.id}
            aria-controls="ef-account-panel"
            tabIndex={section === item.id ? 0 : -1}
            className={section === item.id ? 'is-active' : ''}
            key={item.id}
            onClick={() => onSectionChange(item.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            <span className="ef-account-nav-icon" aria-hidden="true">{item.icon}</span>
            <span className="ef-account-nav-copy"><strong>{item.label}</strong><small>{item.detail}</small></span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="ef-account-signout"
        disabled={authPending || activeJobCount > 0}
        aria-busy={authPending || undefined}
        title={activeJobCount > 0 ? `Finish ${activeJobCount} active job${activeJobCount === 1 ? '' : 's'} before signing out.` : undefined}
        onClick={() => void onRequestSignOut()}
      ><span aria-hidden="true">↪</span>{authPending ? 'Signing out…' : 'Sign out'}</button>
    </nav>
  )
}

function AccountSectionHeader({ section, status, tone = 'neutral' }: { section: AccountSection; status: string; tone?: 'ok' | 'warning' | 'neutral' }) {
  const item = ACCOUNT_SECTIONS.find((candidate) => candidate.id === section) ?? ACCOUNT_SECTIONS[0]
  return (
    <header className="ef-account-section-head">
      <div><small>{item.eyebrow}</small><h2>{item.title}</h2><p>{item.description}</p></div>
      <span className={`ef-account-section-status is-${tone}`}><i aria-hidden="true" />{status}</span>
    </header>
  )
}

function OverviewSection({
  props,
  activePartner,
  isAdmin,
  isSupport,
  onSectionChange,
}: {
  props: AccountProps
  activePartner: boolean
  isAdmin: boolean
  isSupport: boolean
  onSectionChange: (section: AccountSection) => void
}) {
  const session = props.session.status === 'signed-in' ? props.session : null
  if (!session) return null
  const customerCredits = props.balances ? formatCreditMicros(totalCreditMicros(props.balances)) : '—'
  const access = isAdmin
    ? 'Admin direct access'
    : isSupport
      ? 'Support workspace access'
    : activePartner
      ? 'Partner lifetime access'
      : props.subscription
        ? `${SUBSCRIPTION_PLANS[props.subscription.planId].name} · ${STATUS_LABELS[props.subscription.status]}`
        : 'No active membership'
  const creditValue = isSupport ? 'Not applicable' : isAdmin || activePartner ? providerCreditLabel(props) : customerCredits
  const period = isAdmin || isSupport || activePartner
    ? 'No EasyField renewal required'
    : props.subscription?.currentPeriodEndMs
      ? `${props.subscription.cancelAtPeriodEnd ? 'Ends' : 'Renews'} ${formatAccountDate(props.subscription.currentPeriodEndMs)}`
      : 'No billing date available'
  return (
    <section className="ef-account-overview" aria-labelledby="ef-account-overview-title">
      <div className="ef-account-overview-copy">
        <span>WELCOME BACK</span>
        <h3 id="ef-account-overview-title">{session.displayName?.trim() || session.email.split('@')[0]}</h3>
        <p>Your identity, access and credits stay together across every EasyField workspace.</p>
        <div className="ef-account-overview-badges">
          <i className={session.emailVerified ? 'is-ok' : 'is-warning'}>{session.emailVerified ? 'Email verified' : 'Verification needed'}</i>
          <i>{roleLabel(session, activePartner)}</i>
        </div>
      </div>
      <div className="ef-account-overview-metrics">
        <article><small>ACCESS</small><strong>{access}</strong><span>{period}</span></article>
        <article><small>AVAILABLE CREDITS</small><strong>{creditValue}</strong><span>{isSupport ? 'No customer wallet' : isAdmin || activePartner ? 'Direct balance' : 'Across all credit types'}</span></article>
        <article><small>GENERATION</small><strong>{props.generationReady ? 'Ready' : 'Needs attention'}</strong><span>{props.generationReady ? 'Paid actions are available' : isSupport ? 'Support access only' : 'Review access, verification or connection'}</span></article>
      </div>
      <div className="ef-account-overview-actions">
        {!isAdmin && !isSupport && !activePartner && <button type="button" onClick={() => onSectionChange('billing')}>Manage plan</button>}
        {!isSupport && <button type="button" onClick={() => onSectionChange('credits')}>{isAdmin || activePartner ? 'Manage credits' : 'Buy credits'}</button>}
        <button type="button" onClick={() => onSectionChange('connections')}>View connections</button>
      </div>
    </section>
  )
}

function ProfileSection({ props, session, activePartner }: { props: AccountProps; session: Extract<AccountSession, { status: 'signed-in' }>; activePartner: boolean }) {
  const name = session.displayName?.trim() || 'EasyField account'
  const [displayName, setDisplayName] = useState(session.displayName?.trim() ?? '')
  useEffect(() => setDisplayName(session.displayName?.trim() ?? ''), [session.accountId, session.displayName])
  const normalizedName = displayName.trim()
  const unchanged = normalizedName === (session.displayName?.trim() ?? '')
  return (
    <section className="ef-account-section ef-account-profile" aria-labelledby="ef-account-profile-title">
      <div className="ef-account-profile-card">
        <span aria-hidden="true">{name === 'EasyField account' ? session.email.slice(0, 1).toUpperCase() : name.slice(0, 1).toUpperCase()}</span>
        <div><h3 id="ef-account-profile-title">{name}</h3><p>{session.email}</p><i>{roleLabel(session, activePartner)}</i></div>
      </div>
      <form className="ef-account-profile-form" onSubmit={(event) => { event.preventDefault(); if (!unchanged && normalizedName) void props.onRequestProfileUpdate(normalizedName) }}>
        <label htmlFor="ef-account-display-name"><span>Display name</span><small>Shown only inside your EasyField account.</small></label>
        <input id="ef-account-display-name" type="text" minLength={1} maxLength={160} autoComplete="name" value={displayName} disabled={props.profilePending} onChange={(event) => setDisplayName(event.target.value)} />
        <button type="submit" className="ef-account-secondary" disabled={props.profilePending || unchanged || !normalizedName} aria-busy={props.profilePending || undefined}>{props.profilePending ? 'Saving…' : 'Save name'}</button>
      </form>
      <Feedback value={props.profileFeedback} />
      <dl className="ef-account-detail-list">
        <div><dt>Email address</dt><dd>{session.email}</dd></div>
        <div><dt>Email status</dt><dd className={session.emailVerified ? 'is-ok' : 'is-warning'}>{session.emailVerified ? 'Verified' : 'Verification required'}</dd></div>
        <div><dt>Account type</dt><dd>{roleLabel(session, activePartner)}</dd></div>
      </dl>
      <p className="ef-account-readonly-note"><span aria-hidden="true">◇</span>Your email address and account role remain managed by secure sign-in.</p>
    </section>
  )
}

function AccessSummarySection({ session, activePartner, onSectionChange }: { session: Extract<AccountSession, { status: 'signed-in' }>; activePartner: boolean; onSectionChange: (section: AccountSection) => void }) {
  const admin = session.platformRole === 'admin'
  const support = session.platformRole === 'support'
  const membership = activePartner ? 'Partner · Lifetime' : admin ? 'Admin' : 'Support'
  return (
    <section className="ef-account-section ef-account-access-summary" aria-labelledby="ef-account-access-title">
      <div><span aria-hidden="true">◆</span><div><small>{admin ? 'ADMIN ACCESS' : support ? 'SUPPORT ACCESS' : 'LIFETIME MEMBERSHIP'}</small><h3 id="ef-account-access-title">{admin ? 'Direct workspace access' : support ? 'Support workspace access' : 'Partner access is active'}</h3><p>{admin || support ? 'This account does not require an EasyField customer subscription.' : 'All verified model families are included. Credits are purchased through your direct connection.'}</p></div></div>
      <div className="ef-account-access-facts">
        <span><small>MEMBERSHIP</small><strong>{membership}</strong></span>
        <span><small>MODEL ACCESS</small><strong>{support ? 'Support tools only' : 'All verified models'}</strong></span>
        <span><small>RENEWAL</small><strong>Not required</strong></span>
      </div>
      {!support && <button type="button" className="ef-account-primary" onClick={() => onSectionChange('credits')}>Manage direct credits</button>}
    </section>
  )
}

function SupportCreditsSection() {
  return (
    <section className="ef-account-section ef-account-access-summary" aria-labelledby="ef-account-support-credits-title">
      <div><span aria-hidden="true">◇</span><div><small>SUPPORT ACCOUNT</small><h3 id="ef-account-support-credits-title">No customer credit wallet</h3><p>Plans, top-ups and direct billing are not available to internal Support accounts.</p></div></div>
    </section>
  )
}

function SecuritySection(props: AccountProps) {
  const session = props.session.status === 'signed-in' ? props.session : null
  if (!session) return null
  return (
    <section className="ef-account-section ef-account-security" aria-labelledby="ef-account-security-title">
      <div className="ef-account-security-row">
        <span aria-hidden="true">✉</span>
        <div><h3 id="ef-account-security-title">Email verification</h3><p>{session.emailVerified ? `${session.email} is verified.` : `Verify ${session.email} before starting paid actions.`}</p></div>
        {session.emailVerified
          ? <i className="is-ok">Verified</i>
          : props.onRequestResendVerification && <button type="button" disabled={props.verificationPending} aria-busy={props.verificationPending || undefined} onClick={() => void props.onRequestResendVerification?.()}>{props.verificationPending ? 'Sending…' : 'Resend verification'}</button>}
      </div>
      <div className="ef-account-security-row">
        <span aria-hidden="true">↻</span>
        <div><h3>Password</h3><p>Send a one-time recovery link to {session.email}. The new password is entered only after the link is verified.</p></div>
        <button type="button" disabled={props.passwordResetPending || props.authPending} aria-busy={props.passwordResetPending || undefined} onClick={() => void props.onRequestPasswordReset(session.email)}>{props.passwordResetPending ? 'Sending…' : 'Send reset email'}</button>
      </div>
      <Feedback value={props.passwordResetFeedback} />
      <div className="ef-account-security-row">
        <span aria-hidden="true">⌁</span>
        <div><h3>Current session</h3><p>EasyField is signed in on this Mac. Signing out removes the local account session without deleting Library media.</p></div>
        <button type="button" className="is-danger" disabled={props.authPending || (props.activeJobCount ?? 0) > 0} aria-busy={props.authPending || undefined} title={(props.activeJobCount ?? 0) > 0 ? `Finish ${props.activeJobCount} active job${props.activeJobCount === 1 ? '' : 's'} before signing out.` : undefined} onClick={() => void props.onRequestSignOut()}>{props.authPending ? 'Signing out…' : 'Sign out'}</button>
      </div>
      {(props.activeJobCount ?? 0) > 0 && <p className="ef-account-readonly-note is-warning"><span aria-hidden="true">!</span>Sign out is available after active work finishes, so paid results can still be secured locally.</p>}
    </section>
  )
}

function ConnectionsSection(props: AccountProps) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [disconnectError, setDisconnectError] = useState('')
  const manageButtonRef = useRef<HTMLButtonElement>(null)
  const disconnectButtonRef = useRef<HTMLButtonElement>(null)
  const keepConnectedButtonRef = useRef<HTMLButtonElement>(null)
  const directAllowed = props.capabilities.directProviderAllowed
  const directPresent = props.directConnectionPresent === true
  const directConnected = directAllowed && directPresent && typeof props.directProviderCredits === 'number' && Number.isFinite(props.directProviderCredits)
  useEffect(() => {
    if (!directPresent) {
      setConfirmDisconnect(false)
      setDisconnectError('')
    }
  }, [directPresent])

  useEffect(() => {
    if (confirmDisconnect) keepConnectedButtonRef.current?.focus()
  }, [confirmDisconnect])

  const cancelDisconnect = () => {
    setConfirmDisconnect(false)
    requestAnimationFrame(() => disconnectButtonRef.current?.focus() ?? manageButtonRef.current?.focus())
  }

  const disconnect = async () => {
    if (!props.onDisconnectDirectConnection || props.directConnectionPending) return
    setDisconnectError('')
    try {
      await props.onDisconnectDirectConnection()
      setConfirmDisconnect(false)
      requestAnimationFrame(() => manageButtonRef.current?.focus())
    } catch {
      setDisconnectError('EasyField could not disconnect this Mac. Try again.')
    }
  }
  const rows = [
    { label: 'EasyField account', detail: props.capabilities.accountConfigured ? 'Authenticated account service' : 'Account service is unavailable', state: props.capabilities.accountConfigured ? 'Connected' : 'Unavailable', tone: props.capabilities.accountConfigured ? 'is-ok' : 'is-warning' },
    { label: 'Generation access', detail: 'Server authorization and required connection state', state: props.generationReady ? 'Ready' : 'Needs attention', tone: props.generationReady ? 'is-ok' : 'is-warning' },
    { label: 'This Mac', detail: host.isPlugin() ? 'DaVinci Resolve workflow integration' : 'Browser development runtime', state: host.isPlugin() ? 'Plugin active' : 'Development', tone: 'is-neutral' },
    ...(directAllowed || directPresent ? [{ label: 'Direct cloud connection', detail: 'Private account-scoped connection on this Mac', state: directConnected ? 'Connected' : directPresent && !directAllowed ? 'Saved · access unavailable' : directPresent ? 'Saved · needs attention' : 'Connection needed', tone: directConnected ? 'is-ok' : 'is-warning' }] : []),
  ]
  return (
    <section className="ef-account-section ef-account-connections" aria-labelledby="ef-account-connections-title">
      <h3 id="ef-account-connections-title" className="ef-visually-hidden">Connection status</h3>
      <div className="ef-account-connection-list">
        {rows.map((row) => <article key={row.label}><span aria-hidden="true">{row.tone === 'is-ok' ? '●' : row.tone === 'is-warning' ? '!' : '◇'}</span><div><strong>{row.label}</strong><small>{row.detail}</small></div><i className={row.tone}>{row.state}</i></article>)}
      </div>
      <div className="ef-account-connection-actions">
        {props.onOpenSettings && <button ref={manageButtonRef} type="button" className="ef-account-secondary ef-account-manage-connection" onClick={props.onOpenSettings}>Manage connection</button>}
        {directPresent && props.onDisconnectDirectConnection && !confirmDisconnect && (
          <button ref={disconnectButtonRef} type="button" className="ef-account-secondary is-danger" disabled={props.directConnectionPending || (props.activeJobCount ?? 0) > 0} title={(props.activeJobCount ?? 0) > 0 ? `Finish ${props.activeJobCount} active job${props.activeJobCount === 1 ? '' : 's'} before disconnecting.` : undefined} onClick={() => setConfirmDisconnect(true)}>Disconnect</button>
        )}
      </div>
      {directPresent && props.onDisconnectDirectConnection && confirmDisconnect && (
        <div className="ef-account-disconnect-confirm" role="status">
          <div><strong>Disconnect this Mac?</strong><small>New direct generations will pause. Active jobs must finish first so EasyField can secure their results.</small></div>
          <button ref={keepConnectedButtonRef} type="button" disabled={props.directConnectionPending} onClick={cancelDisconnect}>Keep connected</button>
          <button type="button" className="is-danger" disabled={props.directConnectionPending || (props.activeJobCount ?? 0) > 0} aria-busy={props.directConnectionPending || undefined} onClick={() => void disconnect()}>{props.directConnectionPending ? 'Disconnecting…' : 'Confirm disconnect'}</button>
        </div>
      )}
      {directPresent && (props.activeJobCount ?? 0) > 0 && <p className="ef-account-readonly-note is-warning"><span aria-hidden="true">!</span>Connection controls unlock after active work finishes.</p>}
      {disconnectError && <div className="ef-account-feedback is-error" role="alert">{disconnectError}</div>}
      <p className="ef-account-readonly-note"><span aria-hidden="true">◇</span>Credentials and private service details never appear in this interface.</p>
    </section>
  )
}

export function Account(props: AccountProps) {
  const [section, setSection] = useState<AccountSection>('overview')
  const contentRef = useRef<HTMLElement>(null)
  const signedInSession = props.session.status === 'signed-in' ? props.session : null
  const signedInAccountId = signedInSession?.accountId ?? null
  useEffect(() => setSection('overview'), [signedInAccountId])
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0
  }, [section, signedInAccountId])
  const isAdmin = signedInSession?.platformRole === 'admin'
  const isSupport = signedInSession?.platformRole === 'support'
  const eligibleSubscription = subscriptionAllowsTopUps(props.subscription) ? props.subscription : null
  const hasEligiblePlan = eligibleSubscription != null
  const pricingPlanId = eligibleSubscription?.planId ?? props.selectedPlanId
  const identityLocked = signedInSession != null && !signedInSession.emailVerified
  const unresolvedCheckout = Boolean(
    props.checkoutResumePending
    || props.planCheckoutPending
    || props.topUpPending
    || props.partnerCheckoutPending
    || props.checkoutStatus?.state === 'pending'
    || props.checkoutStatus?.state === 'ready-to-resume'
    || props.checkoutStatus?.state === 'awaiting-reconciliation'
  )
  const billingLocked = !props.capabilities.customerCheckoutAvailable || identityLocked || unresolvedCheckout
  const managedSubscription = Boolean(props.subscription && props.subscription.status !== 'canceled' && props.subscription.status !== 'expired')
  const partnerBillingLocked = !props.capabilities.partnerCheckoutAvailable || identityLocked || unresolvedCheckout
  const portalLocked = !props.capabilities.billingPortalAvailable || identityLocked || unresolvedCheckout
  const topUpLocked = billingLocked || !hasEligiblePlan
  const activePartner = hasActivePartnerEntitlement(props.partnerEntitlement)
  const showCustomerBilling = signedInSession?.platformRole === 'customer' && !activePartner
  const customerCreditLabel = props.balances ? formatCreditMicros(totalCreditMicros(props.balances)) : '—'
  const sectionStatus = section === 'overview'
    ? { label: props.generationReady ? 'Generation ready' : 'Needs attention', tone: props.generationReady ? 'ok' : 'warning' } as const
    : section === 'profile'
      ? { label: signedInSession?.emailVerified ? 'Verified identity' : 'Verification needed', tone: signedInSession?.emailVerified ? 'ok' : 'warning' } as const
      : section === 'billing'
        ? isAdmin
          ? { label: 'Admin access', tone: 'neutral' } as const
          : isSupport
            ? { label: 'Support access', tone: 'neutral' } as const
          : activePartner
            ? { label: 'Lifetime access', tone: 'ok' } as const
            : props.subscription
              ? { label: `${SUBSCRIPTION_PLANS[props.subscription.planId].name} · ${STATUS_LABELS[props.subscription.status]}`, tone: subscriptionAllowsTopUps(props.subscription) ? 'ok' : 'warning' } as const
              : { label: 'Choose a plan', tone: 'neutral' } as const
        : section === 'credits'
          ? { label: isSupport ? 'No customer wallet' : isAdmin || activePartner ? `${providerCreditLabel(props)} credits` : `${customerCreditLabel} credits`, tone: 'neutral' } as const
          : section === 'security'
            ? { label: signedInSession?.emailVerified ? 'Email verified' : 'Verification needed', tone: signedInSession?.emailVerified ? 'ok' : 'warning' } as const
            : { label: props.capabilities.accountConfigured ? 'Account connected' : 'Service unavailable', tone: props.capabilities.accountConfigured ? 'ok' : 'warning' } as const

  return (
    <div className="ef-screen ef-account-screen">
      <AccountHeader onBack={props.onBack} />
      {props.passwordRecovery?.state === 'ready' ? <PasswordRecoveryView {...props} recovery={props.passwordRecovery} /> : !signedInSession ? <AuthView {...props} /> : (
        <div className="ef-account-layout">
          <AccountNavigation
            session={signedInSession}
            activePartner={activePartner}
            section={section}
            authPending={props.authPending}
            activeJobCount={props.activeJobCount}
            onSectionChange={setSection}
            onRequestSignOut={props.onRequestSignOut}
          />
          <main
            ref={contentRef}
            className="ef-account-content ef-scroll"
            role="tabpanel"
            id="ef-account-panel"
            aria-labelledby={`ef-account-tab-${section}`}
            tabIndex={0}
          >
            <AccountSectionHeader section={section} status={sectionStatus.label} tone={sectionStatus.tone} />
            {props.authFeedback && <Feedback value={props.authFeedback} />}
            {props.checkoutStatus && (
              <CheckoutRecoverySection
                checkoutStatus={props.checkoutStatus}
                checkoutResumePending={props.checkoutResumePending}
                onRequestResumeCheckout={props.onRequestResumeCheckout}
                accountRefreshPending={props.accountRefreshPending}
                accountRefreshFeedback={props.accountRefreshFeedback}
                onRequestRefreshAccount={props.onRequestRefreshAccount}
                onDismissCheckoutStatus={props.onDismissCheckoutStatus}
              />
            )}
            {signedInSession.platformRole === 'customer' && !signedInSession.emailVerified && section !== 'security' && (
              <section className="ef-account-verify" role="status">
                <span aria-hidden="true">✉</span>
                <div><strong>Verify {signedInSession.email}</strong><p>Verify your email before starting plan or top-up checkout.</p></div>
                {props.onRequestResendVerification && <button type="button" disabled={props.verificationPending} aria-busy={props.verificationPending || undefined} onClick={() => void props.onRequestResendVerification?.()}>{props.verificationPending ? 'Sending…' : 'Resend verification'}</button>}
              </section>
            )}
            {showCustomerBilling && !props.capabilities.customerCheckoutAvailable && (section === 'billing' || section === 'credits') && (
              <section className="ef-account-verify" role="status">
                <span aria-hidden="true">!</span>
                <div><strong>Purchases are temporarily unavailable</strong><p>You can still review your account and existing credit balance.</p></div>
              </section>
            )}

            {section === 'overview' && (
              <>
                <OverviewSection props={props} activePartner={activePartner} isAdmin={isAdmin} isSupport={isSupport} onSectionChange={setSection} />
                {!props.checkoutStatus && (
                  <section className="ef-account-refresh" aria-label="Account status">
                    <div><strong>Account status</strong><p>Refresh whenever access and credits look out of date.</p></div>
                    <button type="button" disabled={props.accountRefreshPending} aria-busy={props.accountRefreshPending || undefined} onClick={() => void props.onRequestRefreshAccount()}>
                      {props.accountRefreshPending ? 'Refreshing…' : 'Refresh account'}
                    </button>
                    {props.accountRefreshFeedback && <Feedback value={props.accountRefreshFeedback} />}
                  </section>
                )}
              </>
            )}
            {section === 'profile' && <ProfileSection props={props} session={signedInSession} activePartner={activePartner} />}
            {section === 'billing' && (
              <>
                {(isAdmin || isSupport || activePartner) && <AccessSummarySection session={signedInSession} activePartner={activePartner} onSectionChange={setSection} />}
                {showCustomerBilling && <PlansSection {...props} billingLocked={billingLocked} portalLocked={portalLocked} managedSubscription={managedSubscription} />}
                {signedInSession.platformRole === 'customer' && <PartnerMembershipSection {...props} billingLocked={partnerBillingLocked} activePartner={activePartner} />}
              </>
            )}
            {section === 'credits' && (
              <>
                {showCustomerBilling && <BalanceSection balances={props.balances} subscription={props.subscription} />}
                {showCustomerBilling && <TopUpSection {...props} billingLocked={topUpLocked} pricingPlanId={pricingPlanId} hasEligiblePlan={hasEligiblePlan} />}
                {showCustomerBilling && <AutoReloadSection {...props} billingLocked={topUpLocked} pricingPlanId={pricingPlanId} hasEligiblePlan={hasEligiblePlan} />}
                {isSupport && <SupportCreditsSection />}
                <PrivilegedBillingSection
                  session={props.session}
                  directProviderAllowed={props.capabilities.directProviderAllowed}
                  privilegedBilling={props.privilegedBilling}
                  adminBilling={props.adminBilling}
                  directProviderCredits={props.directProviderCredits}
                  upstreamTopUpPending={props.upstreamTopUpPending}
                  upstreamTopUpFeedback={props.upstreamTopUpFeedback}
                  onRequestUpstreamTopUp={props.onRequestUpstreamTopUp}
                />
              </>
            )}
            {section === 'security' && <SecuritySection {...props} />}
            {section === 'connections' && <ConnectionsSection {...props} />}
          </main>
        </div>
      )}
    </div>
  )
}

export default Account
