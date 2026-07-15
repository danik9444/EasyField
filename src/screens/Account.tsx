import { useId } from 'react'
import '../account.css'
import {
  PARTNER_MEMBERSHIP,
  SUBSCRIPTION_PLAN_IDS,
  SUBSCRIPTION_PLANS,
  minimumTopUpCreditMicros,
  quoteTopUp,
  validateAutoReloadPolicy,
  type AutoReloadPolicy,
  type BillingInterval,
  type CreditMicros,
  type SubscriptionPlanId,
} from '../data/subscriptions'
import {
  canShowPrivilegedBilling,
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
import { host } from '../services/host'

export interface AccountFeedback {
  tone: 'neutral' | 'success' | 'error'
  message: string
}

export interface AccountProps {
  onBack: () => void
  session: AccountSession

  authMode: AccountAuthMode
  authEmail: string
  authPassword: string
  authPending?: boolean
  authFeedback?: AccountFeedback | null
  onAuthModeChange: (mode: AccountAuthMode) => void
  onAuthEmailChange: (email: string) => void
  onAuthPasswordChange: (password: string) => void
  onRequestEmailPasswordAuth: (request: EmailPasswordAuthRequest) => void | Promise<void>
  onRequestGoogleAuth: () => void | Promise<void>
  onRequestAppleAuth: () => void | Promise<void>
  onRequestPasswordReset?: (email: string) => void | Promise<void>
  onRequestResendVerification?: () => void | Promise<void>
  verificationPending?: boolean
  onRequestSignOut: () => void | Promise<void>

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
  /** @deprecated Compatibility alias for existing admin integrations. */
  adminBilling?: AccountAdminBillingSnapshot | null
  upstreamTopUpPending?: boolean
  upstreamTopUpFeedback?: AccountFeedback | null
  onRequestUpstreamTopUp?: () => void | Promise<void>
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
            disabled={props.authPending}
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
            disabled={props.authPending}
            required
          />
          {!signUp && props.onRequestPasswordReset && (
            <button
              type="button"
              className="ef-account-reset"
              disabled={props.authPending || !props.authEmail.trim()}
              onClick={() => void props.onRequestPasswordReset?.(props.authEmail.trim())}
            >Forgot password?</button>
          )}
          {signUp && <p className="ef-account-verification-note"><span aria-hidden="true">✉</span>Email verification is required before paid actions are available.</p>}
          <button className="ef-account-primary" type="submit" disabled={props.authPending}>
            {props.authPending ? 'Please wait…' : signUp ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <Feedback value={props.authFeedback} />

        <div className="ef-account-divider"><span>or continue with</span></div>
        <div className="ef-account-socials">
          <button type="button" onClick={() => void props.onRequestGoogleAuth()} disabled={props.authPending}><b aria-hidden="true">G</b>Google</button>
          <button type="button" onClick={() => void props.onRequestAppleAuth()} disabled={props.authPending}><b aria-hidden="true">●</b>Apple</button>
        </div>
        <p className="ef-account-auth-footnote">Authentication and billing results appear only after the account service confirms them.</p>
      </section>
    </main>
  )
}

function AccountHeader({ session, onBack, onRequestSignOut }: Pick<AccountProps, 'session' | 'onBack' | 'onRequestSignOut'>) {
  const identity = session.status === 'signed-in' ? session : null
  return (
    <header className="ef-account-header">
      <button type="button" className="ef-account-back" onClick={onBack} aria-label="Back">←</button>
      <div className="ef-account-heading">
        <span>ACCOUNT</span>
        {identity ? <h1>Plans & credits</h1> : <strong>Plans & credits</strong>}
      </div>
      {identity && (
        <div className="ef-account-identity">
          <span aria-hidden="true">{(identity.displayName ?? identity.email).slice(0, 1).toUpperCase()}</span>
          <div><strong>{identity.displayName ?? 'EasyField account'}</strong><small>{identity.email}</small></div>
          <button type="button" onClick={() => void onRequestSignOut()}>Sign out</button>
        </div>
      )}
    </header>
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

function PlansSection(props: AccountProps & { billingLocked: boolean }) {
  const selectedPlan = SUBSCRIPTION_PLANS[props.selectedPlanId]
  const currentExact = subscriptionAllowsTopUps(props.subscription)
    && props.subscription.planId === props.selectedPlanId
    && props.subscription.billingInterval === props.billingInterval
    && !props.subscription.cancelAtPeriodEnd

  return (
    <section className="ef-account-section" aria-labelledby="ef-account-plans-title">
      <div className="ef-account-section-title ef-account-plans-head">
        <div><span>MEMBERSHIP</span><h2 id="ef-account-plans-title">Choose the pace that fits your work.</h2><p>Plan credits refresh monthly and unused plan credits expire at the next refresh. Annual plans are billed once and release credits in monthly windows.</p></div>
        <div className="ef-account-interval" role="group" aria-label="Billing interval">
          <button type="button" aria-pressed={props.billingInterval === 'monthly'} onClick={() => props.onBillingIntervalChange('monthly')}>Monthly</button>
          <button type="button" aria-pressed={props.billingInterval === 'annual'} onClick={() => props.onBillingIntervalChange('annual')}>Annual</button>
        </div>
      </div>

      {props.subscription && (
        <div className={`ef-account-current is-${props.subscription.status}`}>
          <div><span>CURRENT</span><strong>{SUBSCRIPTION_PLANS[props.subscription.planId].name} · {STATUS_LABELS[props.subscription.status]}</strong></div>
          <p>{props.subscription.currentPeriodEndMs ? `${props.subscription.cancelAtPeriodEnd ? 'Ends' : 'Renews'} ${formatAccountDate(props.subscription.currentPeriodEndMs)}` : 'Billing date unavailable'}</p>
          {props.onRequestBillingPortal && <button type="button" onClick={() => void props.onRequestBillingPortal?.()}>Manage billing</button>}
        </div>
      )}

      <div className="ef-account-plan-grid" role="group" aria-label="Subscription plans">
        {SUBSCRIPTION_PLAN_IDS.map((planId) => {
          const plan = SUBSCRIPTION_PLANS[planId]
          const selected = props.selectedPlanId === planId
          const price = props.billingInterval === 'annual' ? plan.annualMonthlyEquivalentMoneyMicros : plan.monthlyChargeMoneyMicros
          const annualSaving = plan.monthlyChargeMoneyMicros * 12 - plan.annualChargeMoneyMicros
          const current = props.subscription?.planId === planId
          return (
            <button
              type="button"
              aria-pressed={selected}
              className={`ef-account-plan${selected ? ' is-selected' : ''}`}
              key={planId}
              onClick={() => props.onSelectPlan(planId)}
            >
              <span className="ef-account-plan-top"><b>{plan.name}</b>{current && <i>CURRENT</i>}</span>
              <span className="ef-account-plan-price"><strong>{formatMoneyMicros(price)}</strong><small>/ month</small></span>
              {props.billingInterval === 'annual'
                ? <span className="ef-account-plan-billing">{formatMoneyMicros(plan.annualChargeMoneyMicros)} billed yearly · save {formatMoneyMicros(annualSaving)}</span>
                : <span className="ef-account-plan-billing">Billed monthly</span>}
              <span className="ef-account-plan-rule" />
              <span className="ef-account-plan-fact"><b>{formatCreditMicros(plan.monthlyGrantCreditMicros)}</b> credits each month</span>
              <span className="ef-account-plan-fact">Top-ups at {formatMoneyMicros(plan.topUpMoneyMicrosPerCredit, { minimumFractionDigits: 3, maximumFractionDigits: 3 })} / credit</span>
              <span className="ef-account-plan-fact ef-account-model-access">{plan.modelAccessNote}</span>
              <span className="ef-account-plan-select">{selected ? 'Selected' : 'Select plan'}<i aria-hidden="true">→</i></span>
            </button>
          )
        })}
      </div>

      <div className="ef-account-checkout-row">
        <div><small>SELECTED PLAN</small><strong>{selectedPlan.name} · {props.billingInterval === 'annual' ? 'Annual' : 'Monthly'}</strong></div>
        <button
          type="button"
          className="ef-account-primary"
          disabled={props.planCheckoutPending || props.billingLocked || currentExact}
          onClick={() => void props.onRequestPlanCheckout({ planId: props.selectedPlanId, billingInterval: props.billingInterval })}
        >
          {props.planCheckoutPending ? 'Opening checkout…' : currentExact ? 'Current plan' : `Review ${selectedPlan.name} checkout`}
        </button>
      </div>
      <Feedback value={props.planFeedback} />
    </section>
  )
}

function PartnerMembershipSection(props: AccountProps & { billingLocked: boolean; activePartner: boolean }) {
  const product = PARTNER_MEMBERSHIP
  const checkoutUnavailable = !props.onRequestPartnerCheckout

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
            title={checkoutUnavailable ? 'Partner checkout is not connected yet.' : undefined}
            onClick={() => void props.onRequestPartnerCheckout?.({ productId: product.id })}
          >
            {props.partnerCheckoutPending ? 'Opening checkout…' : 'Get lifetime access'}
          </button>
        )}
      </div>
      <Feedback value={props.partnerFeedback} />
    </section>
  )
}

function TopUpSection(props: AccountProps & { billingLocked: boolean; pricingPlanId: SubscriptionPlanId; hasEligiblePlan: boolean }) {
  const parsed = parseWholeCreditInput(props.topUpCredits)
  const quote = parsed.ok ? quoteTopUp(props.pricingPlanId, parsed.amountCreditMicros) : null
  const plan = SUBSCRIPTION_PLANS[props.pricingPlanId]
  const minimumCredits = wholeCreditsFromMicros(minimumTopUpCreditMicros(props.pricingPlanId))
  const validation = !parsed.ok
    ? props.topUpCredits.trim() ? 'Enter a positive whole number of credits.' : `Minimum ${minimumCredits.toLocaleString('en-US')} credits.`
    : !quote?.meetsMinimum
      ? `The minimum top-up is $10 (${minimumCredits.toLocaleString('en-US')} credits on ${plan.name}).`
      : null

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
        <label><span>Credits to add</span><input type="text" inputMode="numeric" pattern="[0-9,]*" value={props.topUpCredits} onChange={(event) => props.onTopUpCreditsChange(event.target.value)} aria-describedby="ef-account-topup-help" placeholder={minimumCredits.toLocaleString('en-US')} /></label>
        <div className="ef-account-quote"><small>ESTIMATED CHARGE</small><strong>{quote ? formatMoneyMicros(quote.chargeMoneyMicros) : '—'}</strong><span>$10 minimum</span></div>
        <button type="button" className="ef-account-primary" disabled={Boolean(validation) || props.topUpPending || props.billingLocked} onClick={requestTopUp}>{props.topUpPending ? 'Opening checkout…' : 'Review top-up'}</button>
      </div>
      <p id="ef-account-topup-help" className={`ef-account-field-help${validation ? ' is-error' : ''}`}>{validation ?? `${parsed.ok ? parsed.wholeCredits.toLocaleString('en-US') : '0'} credits · ${plan.name} plan rate`}</p>
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
  partnerEntitlement,
  privilegedBilling,
  adminBilling,
  upstreamTopUpPending,
  upstreamTopUpFeedback,
  onRequestUpstreamTopUp,
}: Pick<AccountProps, 'session' | 'partnerEntitlement' | 'privilegedBilling' | 'adminBilling' | 'upstreamTopUpPending' | 'upstreamTopUpFeedback' | 'onRequestUpstreamTopUp'>) {
  const snapshot = privilegedBilling ?? adminBilling
  if (!canShowPrivilegedBilling(session, partnerEntitlement, snapshot)) return null
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
        <div><small>PROVIDER BALANCE</small><strong>{snapshot.upstreamBalanceCreditMicros == null ? 'Unavailable' : `${formatCreditMicros(snapshot.upstreamBalanceCreditMicros)} credits`}</strong></div>
        <div><small>LATEST RAW COST</small><strong>{snapshot.latestRawCostMoneyMicros == null || !snapshot.latestRawCostCurrencyCode ? 'Unavailable' : formatMoneyMicros(snapshot.latestRawCostMoneyMicros, { currency: snapshot.latestRawCostCurrencyCode, minimumFractionDigits: 2, maximumFractionDigits: 6 })}</strong></div>
        <div><small>DIRECT RATE</small><strong>{formatMoneyMicros(PARTNER_MEMBERSHIP.directCreditMoneyMicrosPerCredit, { minimumFractionDigits: 3, maximumFractionDigits: 3 })} / credit</strong></div>
        <div><small>MEASURED</small><strong>{formatAccountDate(snapshot.measuredAtMs)}</strong></div>
      </div>
      <Feedback value={upstreamTopUpFeedback} />
    </section>
  )
}

export function Account(props: AccountProps) {
  const signedInSession = props.session.status === 'signed-in' ? props.session : null
  const eligibleSubscription = subscriptionAllowsTopUps(props.subscription) ? props.subscription : null
  const hasEligiblePlan = eligibleSubscription != null
  const pricingPlanId = eligibleSubscription?.planId ?? props.selectedPlanId
  const billingLocked = signedInSession != null && !signedInSession.emailVerified
  const topUpLocked = billingLocked || !hasEligiblePlan
  const activePartner = hasActivePartnerEntitlement(props.partnerEntitlement)

  return (
    <div className="ef-screen ef-account-screen">
      <AccountHeader session={props.session} onBack={props.onBack} onRequestSignOut={props.onRequestSignOut} />
      {!signedInSession ? <AuthView {...props} /> : (
        <main className="ef-account-content ef-scroll">
          {!signedInSession.emailVerified && (
            <section className="ef-account-verify" role="status">
              <span aria-hidden="true">✉</span>
              <div><strong>Verify {signedInSession.email}</strong><p>Verify your email before starting plan or top-up checkout.</p></div>
              {props.onRequestResendVerification && <button type="button" disabled={props.verificationPending} onClick={() => void props.onRequestResendVerification?.()}>{props.verificationPending ? 'Sending…' : 'Resend verification'}</button>}
            </section>
          )}
          {!activePartner && <BalanceSection balances={props.balances} subscription={props.subscription} />}
          {!activePartner && <PlansSection {...props} billingLocked={billingLocked} />}
          <PartnerMembershipSection {...props} billingLocked={billingLocked} activePartner={activePartner} />
          {!activePartner && <TopUpSection {...props} billingLocked={topUpLocked} pricingPlanId={pricingPlanId} hasEligiblePlan={hasEligiblePlan} />}
          {!activePartner && <AutoReloadSection {...props} billingLocked={topUpLocked} pricingPlanId={pricingPlanId} hasEligiblePlan={hasEligiblePlan} />}
          <PrivilegedBillingSection
            session={props.session}
            partnerEntitlement={props.partnerEntitlement}
            privilegedBilling={props.privilegedBilling}
            adminBilling={props.adminBilling}
            upstreamTopUpPending={props.upstreamTopUpPending}
            upstreamTopUpFeedback={props.upstreamTopUpFeedback}
            onRequestUpstreamTopUp={props.onRequestUpstreamTopUp}
          />
        </main>
      )}
    </div>
  )
}

export default Account
