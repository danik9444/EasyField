import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const {
  createAccountService,
  normalizeBaseUrl,
  normalizeCheckoutHosts,
  parseStoredCheckoutState,
  parseStoredSession,
} = require('../plugin/account-service.cjs')

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function configuredService(fetchImpl, overrides = {}) {
  const persistence = overrides.persistence ?? { session: '', checkout: '' }
  const opened = []
  const oauthCompletions = []
  const passwordRecoveryCompletions = []
  const emailConfirmations = []
  const service = createAccountService({
    supabaseUrl: 'https://project.example.test',
    anonKey: 'public-anon-key',
    accountApiUrl: overrides.accountApiUrl ?? '',
    checkoutHosts: overrides.checkoutHosts ?? [],
    oauthProviders: overrides.oauthProviders ?? ['google', 'apple'],
    callbackUrl: 'http://127.0.0.1:18832/auth/callback',
    recoveryCallbackUrl: overrides.recoveryCallbackUrl ?? 'http://127.0.0.1:18832/auth/recovery',
    confirmCallbackUrl: overrides.confirmCallbackUrl ?? 'http://127.0.0.1:18832/auth/confirm',
    fetchImpl,
    readSession: () => persistence.session,
    writeSession: (value) => { persistence.session = value },
    clearSession: () => { persistence.session = '' },
    readCheckoutState: () => persistence.checkout,
    writeCheckoutState: (value) => { persistence.checkout = value },
    clearCheckoutState: () => { persistence.checkout = '' },
    hasDirectProviderCredential: () => false,
    openExternal: async (url) => { opened.push(url) },
    openDirectCreditPurchase: async () => {},
    onOAuthCompleted: (completion) => { oauthCompletions.push(completion) },
    onPasswordRecoveryCompleted: (completion) => { passwordRecoveryCompletions.push(completion) },
    onEmailConfirmed: (completion) => { emailConfirmations.push(completion) },
  })
  return { service, opened, oauthCompletions, passwordRecoveryCompletions, emailConfirmations, stored: () => persistence.session, persistence }
}

const verifiedUser = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'editor@example.com',
  email_confirmed_at: '2026-07-15T08:00:00.000Z',
  user_metadata: { full_name: 'Editor' },
}

const billingSnapshot = {
  as_of: '2026-07-15T08:30:00.000Z',
  profile: {
    user_id: verifiedUser.id,
    email: verifiedUser.email,
    platform_role: 'customer',
  },
  customer_status: 'active',
  account: {
    account_id: '00000000-0000-4000-8000-000000000002',
    available_microcredits: 800_000_000,
    subscription_microcredits: 700_000_000,
    purchased_microcredits: 100_000_000,
    other_microcredits: 0,
  },
  subscription: {
    plan_key: 'starter',
    billing_interval: 'monthly',
    status: 'active',
    current_period_end: '2026-08-15T08:00:00.000Z',
    entitlement_ends_at: '2026-08-15T08:00:00.000Z',
    cancel_at_period_end: false,
  },
  next_expiring_lot: {
    expires_at: '2026-08-15T08:00:00.000Z',
    available_microcredits: 700_000_000,
  },
  auto_reload: null,
}

function signedInFetch(extra = {}) {
  return async (url, options = {}) => {
    const target = String(url)
    if (target.includes('/auth/v1/token?grant_type=password')) {
      return jsonResponse({
        access_token: 'access-token-that-must-not-cross-ipc',
        refresh_token: 'refresh-token-that-stays-in-main',
        expires_in: 3600,
        user: verifiedUser,
      })
    }
    if (target.endsWith('/auth/v1/user')) return jsonResponse(verifiedUser)
    if (target.endsWith('/rest/v1/rpc/my_billing_snapshot')) return jsonResponse(billingSnapshot)
    if (target.includes('/rest/v1/partner_entitlements?')) return jsonResponse([])
    if (target.endsWith('/direct-access')) return jsonResponse({ accountId: verifiedUser.id, allowed: false })
    if (target.endsWith('/service-capabilities')) return jsonResponse(extra.serviceCapabilities ?? {
      accountId: verifiedUser.id,
      customerGenerationReady: true,
      customerCheckoutAvailable: true,
      partnerCheckoutAvailable: true,
      billingPortalAvailable: true,
    })
    if (extra.checkoutStatus && target.endsWith('/checkout-status')) return extra.checkoutStatus(url, options)
    if (extra.checkout && target.endsWith('/checkout')) return extra.checkout(url, options)
    if (extra.autoReload && target.endsWith('/auto-reload')) return extra.autoReload(url, options)
    throw new Error(`Unexpected request: ${target}`)
  }
}

test('account configuration and stored-session parsers fail closed', () => {
  assert.equal(normalizeBaseUrl('http://insecure.example.test'), '')
  assert.equal(normalizeBaseUrl('https://example.test/path/?secret=yes'), 'https://example.test/path')
  assert.deepEqual([...normalizeCheckoutHosts(['Checkout.Example.test', 'https://bad.example'])], ['checkout.example.test'])
  assert.deepEqual(parseStoredSession('{"version":1,"refreshToken":"refresh"}'), { version: 1, refreshToken: 'refresh' })
  assert.equal(parseStoredSession('{"version":1,"accessToken":"must-not-be-used"}'), null)
  assert.equal(parseStoredCheckoutState('{"version":1,"requestId":"invalid"}'), null)
})

test('an unconfigured build stays signed out and never simulates authentication', async () => {
  const service = createAccountService({
    readSession: () => '',
    writeSession: () => assert.fail('must not persist'),
    clearSession: () => {},
    oauthProviders: ['google', 'apple'],
    hasDirectProviderCredential: () => false,
    openExternal: async () => {},
    openDirectCreditPurchase: async () => {},
  })
  const restored = await service.restore()
  assert.equal(restored.ok, true)
  assert.equal(restored.value.session.status, 'signed-out')
  assert.equal(restored.value.capabilities.accountConfigured, false)
  assert.deepEqual(restored.value.capabilities.oauthProviders, [])
  const signIn = await service.signIn({ email: 'editor@example.com', password: 'correct-horse' })
  assert.deepEqual(signIn, {
    ok: false,
    error: {
      code: 'service-unavailable',
      message: 'EasyField account service is not configured in this build.',
      retryable: false,
    },
  })

  const storedLegacyCredential = createAccountService({
    readSession: () => '',
    writeSession: () => assert.fail('must not persist'),
    clearSession: () => {},
    hasDirectProviderCredential: () => true,
    openExternal: async () => {},
    openDirectCreditPurchase: async () => {},
  })
  const legacySnapshot = await storedLegacyCredential.restore()
  assert.equal(legacySnapshot.ok, true)
  assert.equal(legacySnapshot.value.capabilities.directProviderAllowed, false)

  const explicitDevelopmentCompatibility = createAccountService({
    readSession: () => '',
    writeSession: () => assert.fail('must not persist'),
    clearSession: () => {},
    allowLegacyDirectProvider: true,
    hasDirectProviderCredential: () => true,
    openExternal: async () => {},
    openDirectCreditPurchase: async () => {},
  })
  const developmentSnapshot = await explicitDevelopmentCompatibility.restore()
  assert.equal(developmentSnapshot.ok, true)
  assert.equal(developmentSnapshot.value.capabilities.directProviderAllowed, true)
})

test('sign-in returns a sanitized server snapshot while refresh credentials stay Main-owned', async () => {
  const { service, stored } = configuredService(signedInFetch(), {
    accountApiUrl: 'https://account.example.test',
  })
  const result = await service.signIn({ email: 'editor@example.com', password: 'correct-horse' })
  assert.equal(result.ok, true)
  assert.equal(result.value.state, 'authenticated')
  assert.equal(result.value.snapshot.session.status, 'signed-in')
  assert.equal(result.value.snapshot.session.platformRole, 'customer')
  assert.equal(result.value.snapshot.balances.subscriptionCreditMicros, 700_000_000)
  assert.equal(result.value.snapshot.capabilities.generationAccess, true)
  assert.equal(result.value.snapshot.capabilities.directProviderAllowed, false)
  assert.deepEqual(result.value.snapshot.capabilities.oauthProviders, ['google', 'apple'])
  assert.equal(JSON.stringify(result).includes('access-token-that-must-not-cross-ipc'), false)
  assert.equal(JSON.stringify(result).includes('refresh-token-that-stays-in-main'), false)
  assert.equal(stored().includes('refresh-token-that-stays-in-main'), true)
  assert.equal(stored().includes('access-token-that-must-not-cross-ipc'), false)
})

test('direct-provider authorization rechecks the server and fails closed after revocation', async () => {
  let directAllowed = true
  let billingChecks = 0
  let networkAvailable = true
  const adminBilling = structuredClone(billingSnapshot)
  adminBilling.profile.platform_role = 'admin'
  const fetchImpl = async (url, options = {}) => {
    const target = String(url)
    if (!networkAvailable && !target.includes('/auth/v1/token?grant_type=password')) {
      throw new Error('offline')
    }
    if (target.includes('/auth/v1/token?grant_type=password')) {
      return jsonResponse({
        access_token: 'direct-access-token',
        refresh_token: 'direct-refresh-token',
        expires_in: 3600,
        user: verifiedUser,
      })
    }
    if (target.includes('/auth/v1/token?grant_type=refresh_token')) {
      return jsonResponse({
        access_token: 'direct-access-token',
        refresh_token: 'direct-refresh-token',
        expires_in: 3600,
        user: verifiedUser,
      })
    }
    if (target.endsWith('/auth/v1/user')) return jsonResponse(verifiedUser)
    if (target.endsWith('/rest/v1/rpc/my_billing_snapshot')) {
      billingChecks += 1
      return jsonResponse(directAllowed ? adminBilling : billingSnapshot)
    }
    if (target.includes('/rest/v1/partner_entitlements?')) return jsonResponse([])
    if (target.endsWith('/direct-access')) {
      return jsonResponse({ accountId: verifiedUser.id, allowed: directAllowed })
    }
    throw new Error(`Unexpected request: ${target} ${options.method || 'GET'}`)
  }
  const { service } = configuredService(fetchImpl, { accountApiUrl: 'https://account.example.test' })
  assert.equal((await service.signIn({ email: 'editor@example.com', password: 'correct-horse' })).ok, true)

  const checksAfterSignIn = billingChecks
  const first = await service.getFreshDirectProviderContext()
  assert.deepEqual(first, {
    accountConfigured: true,
    authenticated: true,
    accountId: verifiedUser.id,
    directProviderAllowed: true,
  })
  assert.equal(billingChecks, checksAfterSignIn + 1)

  directAllowed = false
  const revoked = await service.getFreshDirectProviderContext()
  assert.equal(revoked.authenticated, true)
  assert.equal(revoked.accountId, verifiedUser.id)
  assert.equal(revoked.directProviderAllowed, false)
  assert.equal(billingChecks, checksAfterSignIn + 2)

  networkAvailable = false
  assert.deepEqual(await service.getFreshDirectProviderContext(), {
    accountConfigured: true,
    authenticated: false,
    accountId: null,
    directProviderAllowed: false,
  })
})

test('checkout is opened only from a server response on an allowlisted HTTPS host', async () => {
  const { service, opened } = configuredService(signedInFetch({
    checkout: async (_url, options) => {
      const request = JSON.parse(options.body)
      return jsonResponse({
        intentId: 'checkout_intent_12345678',
        requestId: request.requestId,
        checkoutKind: request.kind,
        checkoutExpiresAt: '2099-07-15T09:00:00.000Z',
        checkoutUrl: 'https://checkout.example.test/session/opaque',
      })
    },
  }), {
    accountApiUrl: 'https://account.example.test',
    checkoutHosts: ['checkout.example.test'],
  })
  assert.equal((await service.signIn({ email: 'editor@example.com', password: 'correct-horse' })).ok, true)
  const result = await service.checkout({ kind: 'subscription', planId: 'starter', billingInterval: 'monthly' })
  assert.deepEqual(result, {
    ok: true,
    value: { state: 'opened', intentId: 'checkout_intent_12345678' },
  })
  assert.deepEqual(opened, ['https://checkout.example.test/session/opaque'])
})

test('checkout rejects a renderer-controlled or non-allowlisted destination', async () => {
  const { service, opened } = configuredService(signedInFetch({
    checkout: async (_url, options) => {
      const request = JSON.parse(options.body)
      return jsonResponse({
        intentId: 'checkout_intent_12345678',
        requestId: request.requestId,
        checkoutKind: request.kind,
        checkoutUrl: 'https://attacker.invalid/session',
      })
    },
  }), {
    accountApiUrl: 'https://account.example.test',
    checkoutHosts: ['checkout.example.test'],
  })
  await service.signIn({ email: 'editor@example.com', password: 'correct-horse' })
  const result = await service.checkout({
    kind: 'subscription',
    planId: 'starter',
    billingInterval: 'monthly',
    checkoutUrl: 'https://attacker.invalid/from-renderer',
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'checkout-unavailable')
  assert.deepEqual(opened, [])
})

test('checkout rejects an allowlisted response replayed from a different request', async () => {
  const { service, opened } = configuredService(signedInFetch({
    checkout: async (_url, options) => {
      const request = JSON.parse(options.body)
      return jsonResponse({
        intentId: 'checkout_intent_12345678',
        requestId: '123e4567-e89b-42d3-a456-426614174099',
        checkoutKind: request.kind,
        checkoutUrl: 'https://checkout.example.test/session/opaque',
      })
    },
  }), {
    accountApiUrl: 'https://account.example.test',
    checkoutHosts: ['checkout.example.test'],
  })
  await service.signIn({ email: 'editor@example.com', password: 'correct-horse' })
  const result = await service.checkout({ kind: 'subscription', planId: 'starter', billingInterval: 'monthly' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'checkout-unavailable')
  assert.deepEqual(opened, [])
})

test('checkout retries survive restart and retire only after authoritative payment status', async () => {
  const persistence = { session: '', checkout: '' }
  const requestIds = []
  let checkoutCalls = 0
  let purchasedCreditMicros = 100_000_000
  let authoritativeCheckoutState = 'not-found'
  let activeRequestId = ''
  const fetchImpl = async (url, requestOptions = {}) => {
    const target = String(url)
    if (target.includes('/auth/v1/token?grant_type=password')) {
      return jsonResponse({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        user: verifiedUser,
      })
    }
    if (target.endsWith('/auth/v1/user')) return jsonResponse(verifiedUser)
    if (target.endsWith('/rest/v1/rpc/my_billing_snapshot')) {
      const snapshot = structuredClone(billingSnapshot)
      snapshot.account.purchased_microcredits = purchasedCreditMicros
      snapshot.account.available_microcredits = snapshot.account.subscription_microcredits + purchasedCreditMicros
      return jsonResponse(snapshot)
    }
    if (target.includes('/rest/v1/partner_entitlements?')) return jsonResponse([])
    if (target.endsWith('/service-capabilities')) return jsonResponse({
      accountId: verifiedUser.id,
      customerGenerationReady: true,
      customerCheckoutAvailable: true,
      partnerCheckoutAvailable: true,
      billingPortalAvailable: true,
    })
    if (target.endsWith('/checkout-status')) {
      const request = JSON.parse(requestOptions.body)
      if (authoritativeCheckoutState === 'not-found' || request.requestId !== activeRequestId) {
        return jsonResponse({ error: 'not found' }, 404)
      }
      if (authoritativeCheckoutState === 'unavailable') throw new Error('status service unavailable')
      const terminal = authoritativeCheckoutState === 'completed' || authoritativeCheckoutState === 'closed-unpaid'
      return jsonResponse({
        version: 1,
        kind: 'top-up',
        requestId: request.requestId,
        intentId: '123e4567-e89b-42d3-a456-426614174088',
        state: authoritativeCheckoutState,
        terminal,
        mayStartNewCheckout: terminal,
        checkoutUrl: authoritativeCheckoutState === 'open'
          ? 'https://checkout.example.test/session/opaque'
          : null,
        providerExpiresAt: '2099-07-15T09:00:00.000Z',
        updatedAt: '2026-07-15T08:45:00.000Z',
      })
    }
    if (target.endsWith('/checkout')) {
      const request = JSON.parse(requestOptions.body)
      requestIds.push(request.requestId)
      checkoutCalls += 1
      if (checkoutCalls === 1) return jsonResponse({ error: 'temporary' }, 503)
      activeRequestId = request.requestId
      authoritativeCheckoutState = 'open'
      return jsonResponse({
        intentId: '123e4567-e89b-42d3-a456-426614174088',
        requestId: request.requestId,
        checkoutKind: request.kind,
        checkoutExpiresAt: '2099-07-15T09:00:00.000Z',
        checkoutUrl: 'https://checkout.example.test/session/opaque',
      })
    }
    throw new Error(`Unexpected request: ${target}`)
  }
  const options = {
    accountApiUrl: 'https://account.example.test',
    checkoutHosts: ['checkout.example.test'],
    persistence,
  }
  const first = configuredService(fetchImpl, options)
  await first.service.signIn({ email: 'editor@example.com', password: 'correct-horse' })
  assert.equal((await first.service.checkout({ kind: 'top-up', amountCreditMicros: 100_000_000 })).ok, false)
  assert.ok(parseStoredCheckoutState(persistence.checkout))

  const restarted = configuredService(fetchImpl, options)
  const restartedSignIn = await restarted.service.signIn({ email: 'editor@example.com', password: 'correct-horse' })
  assert.equal(restartedSignIn.ok, true)
  assert.equal(restartedSignIn.value.snapshot.checkoutStatus.state, 'ready-to-resume')
  const checkoutCallsBeforeMissingResume = checkoutCalls
  // A missing authoritative record means the first POST may not have reached
  // the service. Recovery retries the exact durable idempotency key rather than
  // allocating a second payable operation.
  const missingResume = await restarted.service.resumeCheckout()
  assert.equal(missingResume.ok, true)
  assert.equal(checkoutCalls, checkoutCallsBeforeMissingResume + 1)
  assert.equal(new Set(requestIds).size, 1)
  const checkoutCallsAfterMissingResume = checkoutCalls

  authoritativeCheckoutState = 'awaiting-reconciliation'
  assert.equal((await restarted.service.resumeCheckout()).ok, false)
  assert.equal(checkoutCalls, checkoutCallsAfterMissingResume)

  authoritativeCheckoutState = 'malformed'
  assert.equal((await restarted.service.resumeCheckout()).ok, false)
  assert.equal(checkoutCalls, checkoutCallsAfterMissingResume)

  authoritativeCheckoutState = 'unavailable'
  assert.equal((await restarted.service.resumeCheckout()).ok, false)
  assert.equal(checkoutCalls, checkoutCallsAfterMissingResume)

  // Once the operation is open, only the authoritative hosted URL is reopened;
  // no additional checkout POST is made.
  authoritativeCheckoutState = 'open'
  assert.equal((await restarted.service.resumeCheckout()).ok, true)
  assert.equal(checkoutCalls, checkoutCallsAfterMissingResume)
  assert.equal((await restarted.service.checkout({ kind: 'top-up', amountCreditMicros: 100_000_000 })).ok, false)
  assert.equal(new Set(requestIds).size, 1)
  const resumed = configuredService(fetchImpl, options)
  const resumedSignIn = await resumed.service.signIn({ email: 'editor@example.com', password: 'correct-horse' })
  assert.equal(resumedSignIn.ok, true)
  assert.equal(resumedSignIn.value.state, 'authenticated')
  const pendingSnapshot = resumedSignIn.value.snapshot
  assert.deepEqual(pendingSnapshot.checkoutStatus, {
    state: 'pending',
    kind: 'top-up',
    startedAtMs: pendingSnapshot.checkoutStatus.startedAtMs,
    expiresAtMs: pendingSnapshot.checkoutStatus.expiresAtMs,
  })
  assert.ok(pendingSnapshot.checkoutStatus.expiresAtMs > pendingSnapshot.checkoutStatus.startedAtMs)

  purchasedCreditMicros = 200_000_000
  const balanceOnly = await resumed.service.getSnapshot({ force: true })
  assert.equal(balanceOnly.ok, true)
  assert.equal(balanceOnly.value.checkoutStatus.state, 'pending')
  assert.notEqual(persistence.checkout, '')

  authoritativeCheckoutState = 'completed'
  const completed = await resumed.service.getSnapshot({ force: true })
  assert.equal(completed.ok, true)
  assert.equal(completed.value.checkoutStatus.state, 'completed')
  assert.equal(completed.value.checkoutStatus.kind, 'top-up')
  assert.equal(persistence.checkout, '')
  assert.equal((await resumed.service.checkout({ kind: 'top-up', amountCreditMicros: 100_000_000 })).ok, true)
  assert.notEqual(requestIds.at(-1), requestIds[0])

})

test('a definitive checkout rejection plus authoritative absence safely retires the prepared operation', async () => {
  const requestIds = []
  const { service, persistence } = configuredService(signedInFetch({
    checkoutStatus: async () => jsonResponse({ error: 'not found' }, 404),
    checkout: async (_url, options) => {
      requestIds.push(JSON.parse(options.body).requestId)
      return jsonResponse({ error: 'product is unavailable' }, 400)
    },
  }), {
    accountApiUrl: 'https://account.example.test',
    checkoutHosts: ['checkout.example.test'],
  })
  assert.equal((await service.signIn({ email: verifiedUser.email, password: 'correct-horse' })).ok, true)

  const first = await service.checkout({ kind: 'top-up', amountCreditMicros: 100_000_000 })
  assert.equal(first.ok, false)
  assert.equal(first.error.code, 'checkout-unavailable')
  assert.equal(persistence.checkout, '')
  assert.deepEqual(service.getCachedSnapshot().checkoutStatus, {
    state: 'closed-unpaid',
    kind: 'top-up',
    updatedAtMs: service.getCachedSnapshot().checkoutStatus.updatedAtMs,
  })

  // No payable server operation exists, so the user is not trapped behind the
  // abandoned local marker and a later click receives a new request ID.
  const second = await service.checkout({ kind: 'top-up', amountCreditMicros: 100_000_000 })
  assert.equal(second.ok, false)
  assert.equal(requestIds.length, 2)
  assert.notEqual(requestIds[0], requestIds[1])
  assert.equal(persistence.checkout, '')
})

test('checkout reasserts the bearer-token owner immediately before durable preparation', async () => {
  const otherUser = {
    ...verifiedUser,
    id: '00000000-0000-4000-8000-000000000099',
    email: 'other-editor@example.com',
  }
  const persistence = { session: '', checkout: '' }
  let authUserReads = 0
  let checkoutPosts = 0
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/auth/v1/token?grant_type=password')) return jsonResponse({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      user: verifiedUser,
    })
    if (target.endsWith('/auth/v1/user')) {
      authUserReads += 1
      return jsonResponse(authUserReads >= 3 ? otherUser : verifiedUser)
    }
    if (target.endsWith('/rest/v1/rpc/my_billing_snapshot')) return jsonResponse(billingSnapshot)
    if (target.includes('/rest/v1/partner_entitlements?')) return jsonResponse([])
    if (target.endsWith('/direct-access')) return jsonResponse({ accountId: verifiedUser.id, allowed: false })
    if (target.endsWith('/service-capabilities')) return jsonResponse({
      accountId: verifiedUser.id,
      customerGenerationReady: true,
      customerCheckoutAvailable: true,
      partnerCheckoutAvailable: true,
      billingPortalAvailable: true,
    })
    if (target.endsWith('/checkout')) {
      checkoutPosts += 1
      return jsonResponse({ error: 'must not submit' }, 500)
    }
    throw new Error(`Unexpected request: ${target}`)
  }
  const { service } = configuredService(fetchImpl, {
    accountApiUrl: 'https://account.example.test',
    checkoutHosts: ['checkout.example.test'],
    persistence,
  })
  assert.equal((await service.signIn({ email: verifiedUser.email, password: 'correct-horse' })).ok, true)

  const result = await service.checkout({ kind: 'top-up', amountCreditMicros: 100_000_000 })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'not-authenticated')
  assert.equal(authUserReads, 3)
  assert.equal(checkoutPosts, 0)
  assert.equal(persistence.checkout, '')
})

test('account-bound checkout recovery survives A to B to A account switching', async () => {
  const userA = verifiedUser
  const userB = {
    ...verifiedUser,
    id: '00000000-0000-4000-8000-000000000099',
    email: 'another-editor@example.com',
    user_metadata: { full_name: 'Another Editor' },
  }
  const users = new Map([[userA.email, userA], [userB.email, userB]])
  const persistence = { session: '', checkout: '' }
  const remoteByRequestId = new Map()
  const firstRequestByAccount = new Map()
  let currentUser = userA
  let checkoutPosts = 0

  const fetchImpl = async (url, requestOptions = {}) => {
    const target = String(url)
    if (target.includes('/auth/v1/token?grant_type=password')) {
      const request = JSON.parse(requestOptions.body)
      currentUser = users.get(request.email)
      assert.ok(currentUser)
      return jsonResponse({
        access_token: `access-${currentUser.id}`,
        refresh_token: `refresh-${currentUser.id}`,
        expires_in: 3600,
        user: currentUser,
      })
    }
    if (target.includes('/auth/v1/token?grant_type=refresh_token')) {
      return jsonResponse({
        access_token: `access-${currentUser.id}`,
        refresh_token: `refresh-${currentUser.id}`,
        expires_in: 3600,
        user: currentUser,
      })
    }
    if (target.endsWith('/auth/v1/logout')) return jsonResponse({})
    if (target.endsWith('/auth/v1/user')) return jsonResponse(currentUser)
    if (target.endsWith('/rest/v1/rpc/my_billing_snapshot')) {
      const snapshot = structuredClone(billingSnapshot)
      snapshot.profile.user_id = currentUser.id
      snapshot.profile.email = currentUser.email
      return jsonResponse(snapshot)
    }
    if (target.includes('/rest/v1/partner_entitlements?')) return jsonResponse([])
    if (target.endsWith('/direct-access')) {
      return jsonResponse({ accountId: currentUser.id, allowed: false })
    }
    if (target.endsWith('/service-capabilities')) return jsonResponse({
      accountId: currentUser.id,
      customerGenerationReady: true,
      customerCheckoutAvailable: true,
      partnerCheckoutAvailable: true,
      billingPortalAvailable: true,
    })
    if (target.endsWith('/checkout-status')) {
      const request = JSON.parse(requestOptions.body)
      const remote = remoteByRequestId.get(request.requestId)
      if (!remote || remote.accountId !== currentUser.id) return jsonResponse({ error: 'not found' }, 404)
      return jsonResponse({
        version: 1,
        kind: remote.kind,
        requestId: request.requestId,
        intentId: remote.intentId,
        state: remote.state,
        terminal: false,
        mayStartNewCheckout: false,
        checkoutUrl: remote.state === 'open'
          ? `https://checkout.example.test/session/${currentUser.id}`
          : null,
        providerExpiresAt: '2099-07-15T09:00:00.000Z',
        updatedAt: '2026-07-15T08:45:00.000Z',
      })
    }
    if (target.endsWith('/checkout')) {
      checkoutPosts += 1
      const request = JSON.parse(requestOptions.body)
      const existing = remoteByRequestId.get(request.requestId)
      if (!existing) {
        firstRequestByAccount.set(currentUser.id, request.requestId)
        remoteByRequestId.set(request.requestId, {
          accountId: currentUser.id,
          kind: request.kind,
          intentId: currentUser === userA
            ? '123e4567-e89b-42d3-a456-426614174081'
            : '123e4567-e89b-42d3-a456-426614174082',
          state: 'prepared',
        })
        // Simulate the server preparing the idempotent operation while its
        // response is lost. The local account-bound recovery record must live.
        return jsonResponse({ error: 'temporary' }, 503)
      }
      existing.state = 'open'
      return jsonResponse({
        intentId: existing.intentId,
        requestId: request.requestId,
        checkoutKind: request.kind,
        checkoutExpiresAt: '2099-07-15T09:00:00.000Z',
        checkoutUrl: `https://checkout.example.test/session/${currentUser.id}`,
      })
    }
    throw new Error(`Unexpected request: ${target}`)
  }

  const { service, opened } = configuredService(fetchImpl, {
    accountApiUrl: 'https://account.example.test',
    checkoutHosts: ['checkout.example.test'],
    persistence,
  })
  assert.equal((await service.signIn({ email: userA.email, password: 'correct-horse' })).ok, true)
  assert.equal((await service.checkout({ kind: 'top-up', amountCreditMicros: 100_000_000 })).ok, false)
  const userARequestId = firstRequestByAccount.get(userA.id)
  assert.ok(userARequestId)

  const userBSignIn = await service.signIn({ email: userB.email, password: 'correct-horse' })
  assert.equal(userBSignIn.ok, true)
  assert.equal(userBSignIn.value.snapshot.checkoutStatus, null)
  assert.equal((await service.checkout({ kind: 'top-up', amountCreditMicros: 200_000_000 })).ok, false)
  assert.equal(JSON.parse(persistence.checkout).checkouts.length, 2)

  const userAReturn = await service.signIn({ email: userA.email, password: 'correct-horse' })
  assert.equal(userAReturn.ok, true)
  assert.equal(userAReturn.value.snapshot.checkoutStatus.state, 'ready-to-resume')
  assert.equal((await service.resumeCheckout()).ok, true)
  assert.equal(firstRequestByAccount.get(userA.id), userARequestId)
  assert.equal(checkoutPosts, 3)
  assert.equal(JSON.parse(persistence.checkout).checkouts.length, 2)
  assert.deepEqual(opened, [`https://checkout.example.test/session/${userA.id}`])

  const userBReturn = await service.signIn({ email: userB.email, password: 'correct-horse' })
  assert.equal(userBReturn.ok, true)
  assert.equal(userBReturn.value.snapshot.checkoutStatus.state, 'ready-to-resume')
})

test('auto-reload cannot be enabled while paid customer capability is unavailable, but can be disabled', async () => {
  const mutations = []
  const { service } = configuredService(signedInFetch({
    serviceCapabilities: {
      accountId: verifiedUser.id,
      customerGenerationReady: false,
      customerCheckoutAvailable: false,
      partnerCheckoutAvailable: false,
      billingPortalAvailable: false,
    },
    autoReload: async (_url, options) => {
      mutations.push(JSON.parse(options.body))
      return jsonResponse({ saved: true })
    },
  }), {
    accountApiUrl: 'https://account.example.test',
    checkoutHosts: ['checkout.example.test'],
  })
  assert.equal((await service.signIn({ email: verifiedUser.email, password: 'correct-horse' })).ok, true)

  const enable = await service.saveAutoReload({
    policy: {
      enabled: true,
      triggerBalanceCreditMicros: 100_000_000,
      topUpAmountCreditMicros: 200_000_000,
    },
  })
  assert.equal(enable.ok, false)
  assert.equal(enable.error.code, 'checkout-unavailable')
  assert.equal(mutations.length, 0)

  const disable = await service.saveAutoReload({ policy: { enabled: false } })
  assert.equal(disable.ok, true)
  assert.equal(mutations.length, 1)
  assert.equal(mutations[0].policy.enabled, false)
})

test('queued auto-reload remains bound to the account visible when the action was requested', async () => {
  const userA = verifiedUser
  const userB = {
    ...verifiedUser,
    id: '00000000-0000-4000-8000-000000000099',
    email: 'another-editor@example.com',
  }
  const users = new Map([[userA.email, userA], [userB.email, userB]])
  let currentUser = userA
  let autoReloadPosts = 0
  const fetchImpl = async (url, requestOptions = {}) => {
    const target = String(url)
    if (target.includes('/auth/v1/token?grant_type=password')) {
      currentUser = users.get(JSON.parse(requestOptions.body).email)
      return jsonResponse({
        access_token: `access-${currentUser.id}`,
        refresh_token: `refresh-${currentUser.id}`,
        expires_in: 3600,
        user: currentUser,
      })
    }
    if (target.includes('/auth/v1/token?grant_type=refresh_token')) return jsonResponse({
      access_token: `access-${currentUser.id}`,
      refresh_token: `refresh-${currentUser.id}`,
      expires_in: 3600,
      user: currentUser,
    })
    if (target.endsWith('/auth/v1/user')) return jsonResponse(currentUser)
    if (target.endsWith('/rest/v1/rpc/my_billing_snapshot')) {
      const snapshot = structuredClone(billingSnapshot)
      snapshot.profile.user_id = currentUser.id
      snapshot.profile.email = currentUser.email
      return jsonResponse(snapshot)
    }
    if (target.includes('/rest/v1/partner_entitlements?')) return jsonResponse([])
    if (target.endsWith('/direct-access')) return jsonResponse({ accountId: currentUser.id, allowed: false })
    if (target.endsWith('/service-capabilities')) return jsonResponse({
      accountId: currentUser.id,
      customerGenerationReady: true,
      customerCheckoutAvailable: true,
      partnerCheckoutAvailable: true,
      billingPortalAvailable: true,
    })
    if (target.endsWith('/auto-reload')) {
      autoReloadPosts += 1
      return jsonResponse({ saved: true })
    }
    throw new Error(`Unexpected request: ${target}`)
  }
  const { service } = configuredService(fetchImpl, {
    accountApiUrl: 'https://account.example.test',
    checkoutHosts: ['checkout.example.test'],
  })
  assert.equal((await service.signIn({ email: userA.email, password: 'correct-horse' })).ok, true)

  // The account switch enters the serialized queue first. saveAutoReload still
  // captures A synchronously, then refuses to mutate B when its turn arrives.
  const switched = service.signIn({ email: userB.email, password: 'correct-horse' })
  const saved = service.saveAutoReload({ policy: { enabled: false } })
  assert.equal((await switched).ok, true)
  const saveResult = await saved
  assert.equal(saveResult.ok, false)
  assert.equal(saveResult.error.code, 'not-authenticated')
  assert.equal(autoReloadPosts, 0)
})

test('an open social sign-in rejects competing password, signup, and provider attempts', async () => {
  let networkCalls = 0
  const { service, oauthCompletions } = configuredService(async () => {
    networkCalls += 1
    throw new Error('Competing authentication must not reach the network')
  })
  const started = await service.startOAuth({ provider: 'google' })
  assert.equal(started.ok, true)

  const password = await service.signIn({ email: verifiedUser.email, password: 'correct-horse' })
  const signup = await service.signUp({ email: verifiedUser.email, password: 'correct-horse' })
  const provider = await service.startOAuth({ provider: 'apple' })
  assert.equal(password.ok, false)
  assert.equal(password.error.code, 'oauth-in-progress')
  assert.equal(signup.ok, false)
  assert.equal(signup.error.code, 'oauth-in-progress')
  assert.equal(provider.ok, false)
  assert.equal(provider.error.code, 'oauth-in-progress')
  assert.equal(networkCalls, 0)

  assert.equal((await service.signOut()).ok, true)
  assert.deepEqual(oauthCompletions, [{
    attemptId: started.value.attemptId,
    state: 'cancelled',
    message: 'Social sign-in was cancelled.',
  }])
})

test('password auth is rejected while an OAuth callback is adopting its session', async () => {
  let releaseExchange
  const exchangeGate = new Promise((resolve) => { releaseExchange = resolve })
  let markExchangeStarted
  const exchangeStarted = new Promise((resolve) => { markExchangeStarted = resolve })
  let passwordRequests = 0
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/auth/v1/token?grant_type=password')) {
      passwordRequests += 1
      return jsonResponse({ error: 'must not race' }, 500)
    }
    if (target.includes('/auth/v1/token?grant_type=pkce')) {
      markExchangeStarted()
      await exchangeGate
      return jsonResponse({
        access_token: 'oauth-access-token',
        refresh_token: 'oauth-refresh-token',
        expires_in: 3600,
        user: verifiedUser,
      })
    }
    if (target.includes('/auth/v1/token?grant_type=refresh_token')) return jsonResponse({
      access_token: 'oauth-access-token',
      refresh_token: 'oauth-refresh-token',
      expires_in: 3600,
      user: verifiedUser,
    })
    if (target.endsWith('/auth/v1/user')) return jsonResponse(verifiedUser)
    if (target.endsWith('/rest/v1/rpc/my_billing_snapshot')) return jsonResponse(billingSnapshot)
    if (target.includes('/rest/v1/partner_entitlements?')) return jsonResponse([])
    throw new Error(`Unexpected request: ${target}`)
  }
  const { service, opened } = configuredService(fetchImpl)
  const started = await service.startOAuth({ provider: 'google' })
  assert.equal(started.ok, true)
  const redirectUrl = new URL(new URL(opened[0]).searchParams.get('redirect_to'))
  const attempt = redirectUrl.searchParams.get('attempt')

  const callback = service.handleOAuthCallback(
    { url: `/auth/callback?attempt=${encodeURIComponent(attempt)}&code=single-use-code` },
    { writeHead() {}, end() {} },
  )
  await exchangeStarted
  const competing = await service.signIn({ email: verifiedUser.email, password: 'correct-horse' })
  assert.equal(competing.ok, false)
  assert.equal(competing.error.code, 'oauth-in-progress')
  assert.equal(passwordRequests, 0)
  releaseExchange()
  assert.equal(await callback, true)
  assert.equal(service.getCachedSnapshot().session.status, 'signed-in')
})

test('a sign-out queued before the OAuth callback wins without exchanging the code', async () => {
  let pkceExchanges = 0
  const { service, opened, oauthCompletions } = configuredService(async (url) => {
    if (String(url).includes('/auth/v1/token?grant_type=pkce')) pkceExchanges += 1
    throw new Error(`Unexpected request: ${String(url)}`)
  })
  const started = await service.startOAuth({ provider: 'google' })
  assert.equal(started.ok, true)
  const redirectUrl = new URL(new URL(opened[0]).searchParams.get('redirect_to'))
  const attempt = redirectUrl.searchParams.get('attempt')

  const signedOut = service.signOut()
  const callback = service.handleOAuthCallback(
    { url: `/auth/callback?attempt=${encodeURIComponent(attempt)}&code=single-use-code` },
    { writeHead() {}, end() {} },
  )
  assert.equal((await signedOut).ok, true)
  assert.equal(await callback, true)
  assert.equal(pkceExchanges, 0)
  assert.equal(service.getCachedSnapshot().session.status, 'signed-out')
  assert.deepEqual(oauthCompletions, [{
    attemptId: started.value.attemptId,
    state: 'cancelled',
    message: 'Social sign-in was cancelled.',
  }])
})

test('social sign-in binds the loopback callback nonce inside the PKCE redirect URL', async () => {
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/auth/v1/token?grant_type=pkce')) {
      return jsonResponse({
        access_token: 'oauth-access-token',
        refresh_token: 'oauth-refresh-token',
        expires_in: 3600,
        user: verifiedUser,
      })
    }
    if (target.endsWith('/auth/v1/user')) return jsonResponse(verifiedUser)
    if (target.endsWith('/rest/v1/rpc/my_billing_snapshot')) return jsonResponse(billingSnapshot)
    if (target.includes('/rest/v1/partner_entitlements?')) return jsonResponse([])
    throw new Error(`Unexpected request: ${target}`)
  }
  const { service, opened, oauthCompletions } = configuredService(fetchImpl)
  const started = await service.startOAuth({ provider: 'google' })
  assert.equal(started.ok, true)
  assert.equal(opened.length, 1)

  const authorizeUrl = new URL(opened[0])
  assert.equal(authorizeUrl.searchParams.has('state'), false)
  const redirectUrl = new URL(authorizeUrl.searchParams.get('redirect_to'))
  const attempt = redirectUrl.searchParams.get('attempt')
  assert.match(attempt, /^[A-Za-z0-9_-]{20,}$/)

  const response = {
    writeHead() {},
    end() {},
  }
  const handled = await service.handleOAuthCallback(
    { url: `/auth/callback?attempt=${encodeURIComponent(attempt)}&code=single-use-code` },
    response,
  )
  assert.equal(handled, true)
  assert.equal(service.getCachedSnapshot().session.status, 'signed-in')
  assert.deepEqual(oauthCompletions, [{
    attemptId: started.value.attemptId,
    state: 'authenticated',
    message: 'Signed in securely.',
  }])
})

test('social sign-in fails closed when a provider is absent from the signed build configuration', async () => {
  const { service, opened } = configuredService(async () => {
    throw new Error('A disabled provider must not make a network request')
  }, { oauthProviders: ['google'] })
  const snapshot = await service.restore()
  assert.equal(snapshot.ok, true)
  assert.deepEqual(snapshot.value.capabilities.oauthProviders, ['google'])
  const result = await service.startOAuth({ provider: 'apple' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'service-unavailable')
  assert.equal(opened.length, 0)
})

test('social sign-in reports a sanitized cancellation and permits a new attempt', async () => {
  const { service, opened, oauthCompletions } = configuredService(async () => {
    throw new Error('Cancellation must not exchange a code')
  })
  const started = await service.startOAuth({ provider: 'apple' })
  assert.equal(started.ok, true)
  const redirectUrl = new URL(new URL(opened[0]).searchParams.get('redirect_to'))
  const attempt = redirectUrl.searchParams.get('attempt')
  const response = { writeHead() {}, end() {} }

  assert.equal(await service.handleOAuthCallback(
    { url: `/auth/callback?attempt=${encodeURIComponent(attempt)}&error=access_denied` },
    response,
  ), true)
  assert.deepEqual(oauthCompletions, [{
    attemptId: started.value.attemptId,
    state: 'cancelled',
    message: 'Social sign-in was cancelled.',
  }])

  const restarted = await service.startOAuth({ provider: 'google' })
  assert.equal(restarted.ok, true)
})

test('social sign-in reports a sanitized terminal failure when PKCE exchange fails', async () => {
  const { service, opened, oauthCompletions } = configuredService(async (url) => {
    if (String(url).includes('/auth/v1/token?grant_type=pkce')) return jsonResponse({ error: 'invalid_grant' }, 400)
    throw new Error(`Unexpected request: ${String(url)}`)
  })
  const started = await service.startOAuth({ provider: 'google' })
  assert.equal(started.ok, true)
  const redirectUrl = new URL(new URL(opened[0]).searchParams.get('redirect_to'))
  const attempt = redirectUrl.searchParams.get('attempt')

  assert.equal(await service.handleOAuthCallback(
    { url: `/auth/callback?attempt=${encodeURIComponent(attempt)}&code=single-use-code` },
    { writeHead() {}, end() {} },
  ), true)
  assert.deepEqual(oauthCompletions, [{
    attemptId: started.value.attemptId,
    state: 'failed',
    message: 'EasyField could not complete social sign-in. Try again.',
  }])
  assert.equal(service.getCachedSnapshot().session.status, 'signed-out')
})

test('password recovery keeps PKCE and temporary credentials in Main and finishes signed out', async () => {
  let recoveryRedirect = null
  let recoveryRequest = null
  let exchangeRequest = null
  let passwordUpdate = null
  const fetchImpl = async (url, options = {}) => {
    const target = String(url)
    if (target.includes('/auth/v1/recover')) {
      recoveryRedirect = new URL(target).searchParams.get('redirect_to')
      recoveryRequest = JSON.parse(options.body)
      return jsonResponse({})
    }
    if (target.includes('/auth/v1/token?grant_type=pkce')) {
      exchangeRequest = JSON.parse(options.body)
      return jsonResponse({
        access_token: 'temporary-recovery-access-token',
        refresh_token: 'temporary-recovery-refresh-token',
        expires_in: 300,
        user: verifiedUser,
      })
    }
    if (target.endsWith('/auth/v1/user') && options.method === 'PUT') {
      passwordUpdate = JSON.parse(options.body)
      return jsonResponse(verifiedUser)
    }
    if (target.endsWith('/auth/v1/user')) return jsonResponse(verifiedUser)
    throw new Error(`Unexpected request: ${target}`)
  }
  const { service, passwordRecoveryCompletions, stored } = configuredService(fetchImpl)
  const started = await service.requestPasswordReset({ email: verifiedUser.email })
  assert.equal(started.ok, true)
  assert.equal(started.value.accepted, true)
  assert.match(started.value.attemptId, /^[0-9a-f-]{36}$/i)
  assert.ok(started.value.expiresAtMs > Date.now())
  assert.deepEqual(Object.keys(started.value).sort(), ['accepted', 'attemptId', 'expiresAtMs'])
  assert.equal(JSON.stringify(started).includes('temporary-recovery'), false)
  assert.equal(recoveryRequest.email, verifiedUser.email)
  assert.match(recoveryRequest.code_challenge, /^[A-Za-z0-9_-]{20,}$/)
  assert.equal(recoveryRequest.code_challenge_method, 's256')

  const callback = new URL(recoveryRedirect)
  const callbackNonce = callback.searchParams.get('attempt')
  assert.match(callbackNonce, /^[A-Za-z0-9_-]{20,}$/)
  const response = { writeHead() {}, end() {} }
  assert.equal(await service.handlePasswordRecoveryCallback(
    { url: `/auth/recovery?attempt=${encodeURIComponent(callbackNonce)}&code=single-use-code` },
    response,
  ), true)
  assert.equal(exchangeRequest.auth_code, 'single-use-code')
  assert.match(exchangeRequest.code_verifier, /^[A-Za-z0-9_-]{20,}$/)
  assert.deepEqual(passwordRecoveryCompletions, [{
    attemptId: started.value.attemptId,
    state: 'ready',
    message: 'Choose a new password in EasyField.',
  }])
  assert.equal(service.getCachedSnapshot().session.status, 'signed-out')
  assert.equal(stored(), '')

  const completed = await service.completePasswordRecovery({
    attemptId: started.value.attemptId,
    password: 'new-correct-horse',
    accessToken: 'renderer-must-not-control-this',
  })
  assert.equal(completed.ok, true)
  assert.deepEqual(passwordUpdate, { password: 'new-correct-horse' })
  assert.equal(completed.value.snapshot.session.status, 'signed-out')
  assert.equal(JSON.stringify(completed).includes('temporary-recovery'), false)
  assert.deepEqual(passwordRecoveryCompletions.at(-1), {
    attemptId: started.value.attemptId,
    state: 'completed',
    message: 'Password updated. Sign in with your new password.',
  })
})

test('a mismatched password recovery callback cannot consume the open request', async () => {
  let recoveryRedirect = null
  let exchanges = 0
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/auth/v1/recover')) {
      recoveryRedirect = new URL(target).searchParams.get('redirect_to')
      return jsonResponse({})
    }
    if (target.includes('/auth/v1/token?grant_type=pkce')) {
      exchanges += 1
      return jsonResponse({
        access_token: 'temporary-recovery-access-token',
        refresh_token: 'temporary-recovery-refresh-token',
        expires_in: 300,
        user: verifiedUser,
      })
    }
    if (target.endsWith('/auth/v1/user')) return jsonResponse(verifiedUser)
    throw new Error(`Unexpected request: ${target}`)
  }
  const { service, passwordRecoveryCompletions } = configuredService(fetchImpl)
  const started = await service.requestPasswordReset({ email: verifiedUser.email })
  const nonce = new URL(recoveryRedirect).searchParams.get('attempt')
  const response = { writeHead() {}, end() {} }
  assert.equal(await service.handlePasswordRecoveryCallback(
    { url: '/auth/recovery?attempt=wrong-nonce&code=attacker-code' },
    response,
  ), true)
  assert.equal(exchanges, 0)
  assert.deepEqual(passwordRecoveryCompletions, [])
  assert.equal(await service.handlePasswordRecoveryCallback(
    { url: `/auth/recovery?attempt=${encodeURIComponent(nonce)}&code=valid-code` },
    response,
  ), true)
  assert.equal(exchanges, 1)
  assert.equal(passwordRecoveryCompletions[0].attemptId, started.value.attemptId)
  assert.equal(passwordRecoveryCompletions[0].state, 'ready')
})

test('profile updates stay bound to the authenticated bearer owner', async () => {
  let currentUser = structuredClone(verifiedUser)
  let updateBody = null
  const baseFetch = signedInFetch()
  const fetchImpl = async (url, options = {}) => {
    const target = String(url)
    if (target.endsWith('/auth/v1/user') && options.method === 'PUT') {
      updateBody = JSON.parse(options.body)
      currentUser = { ...currentUser, user_metadata: { ...currentUser.user_metadata, ...updateBody.data } }
      return jsonResponse(currentUser)
    }
    if (target.endsWith('/auth/v1/user')) return jsonResponse(currentUser)
    return baseFetch(url, options)
  }
  const { service } = configuredService(fetchImpl, { accountApiUrl: 'https://account.example.test' })
  assert.equal((await service.signIn({ email: verifiedUser.email, password: 'correct-horse' })).ok, true)
  const updated = await service.updateProfile({
    displayName: '  Director Name  ',
    accountId: '00000000-0000-4000-8000-000000000099',
  })
  assert.equal(updated.ok, true)
  assert.deepEqual(updateBody, { data: { full_name: 'Director Name' } })
  assert.equal(updated.value.session.accountId, verifiedUser.id)
  assert.equal(updated.value.session.displayName, 'Director Name')
})

test('an expired entitlement cannot authorize customer generation even with credits', async () => {
  const expiredBilling = structuredClone(billingSnapshot)
  expiredBilling.as_of = '2026-09-15T08:30:00.000Z'
  const baseFetch = signedInFetch()
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith('/rest/v1/rpc/my_billing_snapshot')) return jsonResponse(expiredBilling)
    return baseFetch(url, options)
  }
  const { service } = configuredService(fetchImpl, { accountApiUrl: 'https://account.example.test' })
  const result = await service.signIn({ email: verifiedUser.email, password: 'correct-horse' })
  assert.equal(result.ok, true)
  assert.equal(result.value.snapshot.balances.subscriptionCreditMicros, 700_000_000)
  assert.equal(result.value.snapshot.subscription.status, 'active')
  assert.equal(result.value.snapshot.capabilities.generationAccess, false)
})


// ---------------------------------------------------------------------------
// Email confirmation
// ---------------------------------------------------------------------------

/**
 * Builds a service whose sign-up requires confirmation, and captures what the
 * plugin sent to Auth so the emailed link can be replayed against the loopback
 * handler exactly as a browser would deliver it.
 */
function confirmationHarness(exchange) {
  const seen = { signupRedirect: null, signupBody: null, exchangeBody: null, exchanges: 0 }
  const fetchImpl = async (target, options = {}) => {
    if (target.includes('/auth/v1/signup')) {
      seen.signupRedirect = new URL(target).searchParams.get('redirect_to')
      seen.signupBody = JSON.parse(options.body)
      // No session in the response is how Supabase signals that the address
      // must be confirmed first.
      return jsonResponse({ id: verifiedUser.id, email: verifiedUser.email })
    }
    if (target.includes('/auth/v1/token?grant_type=pkce')) {
      seen.exchanges += 1
      seen.exchangeBody = JSON.parse(options.body)
      return exchange()
    }
    if (target.includes('/auth/v1/token?grant_type=refresh_token')) {
      // Accepting a session refreshes the snapshot, which refreshes the token.
      return jsonResponse({
        access_token: 'refreshed-access-token',
        refresh_token: 'refreshed-refresh-token',
        expires_in: 3600,
        user: verifiedUser,
      })
    }
    if (target.endsWith('/auth/v1/user')) return jsonResponse(verifiedUser)
    if (target.includes('rpc/my_billing_snapshot')) return jsonResponse(billingSnapshot)
    if (target.includes('partner_entitlements')) return jsonResponse([])
    throw new Error(`Unexpected request: ${target}`)
  }
  return { fetchImpl, seen }
}

const confirmedSession = () => jsonResponse({
  access_token: 'confirmed-access-token',
  refresh_token: 'confirmed-refresh-token',
  expires_in: 3600,
  user: verifiedUser,
})

const silentResponse = () => ({ writeHead() {}, end() {} })

test('sign-up binds the confirmation email back to this process', async () => {
  const { fetchImpl, seen } = confirmationHarness(confirmedSession)
  const { service } = configuredService(fetchImpl)

  const result = await service.signUp({ email: verifiedUser.email, password: 'a-long-enough-password' })
  assert.equal(result.ok, true)
  assert.equal(result.value.state, 'verification-required')

  // Without redirect_to the emailed link lands on the Supabase Site URL and the
  // customer has to come back and sign in by hand.
  const redirect = new URL(seen.signupRedirect)
  assert.equal(redirect.origin + redirect.pathname, 'http://127.0.0.1:18832/auth/confirm')
  assert.match(redirect.searchParams.get('attempt'), /^[A-Za-z0-9_-]{20,}$/)

  // PKCE, because the loopback server can only read query parameters — an
  // implicit-flow token arrives in the fragment and never reaches it.
  assert.match(seen.signupBody.code_challenge, /^[A-Za-z0-9_-]{20,}$/)
  assert.equal(seen.signupBody.code_challenge_method, 's256')

  // The verifier must never leave the process.
  assert.equal(JSON.stringify(result).includes('code_verifier'), false)
})

test('clicking the confirmation link signs the customer in', async () => {
  const { fetchImpl, seen } = confirmationHarness(confirmedSession)
  const { service, emailConfirmations, stored } = configuredService(fetchImpl)

  await service.signUp({ email: verifiedUser.email, password: 'a-long-enough-password' })
  const nonce = new URL(seen.signupRedirect).searchParams.get('attempt')

  assert.equal(await service.handleEmailConfirmationCallback(
    { url: `/auth/confirm?attempt=${encodeURIComponent(nonce)}&code=emailed-code` },
    silentResponse(),
  ), true)

  assert.equal(seen.exchangeBody.auth_code, 'emailed-code')
  assert.match(seen.exchangeBody.code_verifier, /^[A-Za-z0-9_-]{20,}$/)
  assert.equal(emailConfirmations.length, 1)
  assert.equal(emailConfirmations[0].state, 'signed-in')
  assert.notEqual(stored(), '', 'the session must be persisted')
  assert.equal(service.getCachedSnapshot().session.status, 'signed-in')
})

test('a link that does not match the open attempt cannot establish a session', async () => {
  const { fetchImpl, seen } = confirmationHarness(confirmedSession)
  const { service, emailConfirmations, stored } = configuredService(fetchImpl)

  await service.signUp({ email: verifiedUser.email, password: 'a-long-enough-password' })

  assert.equal(await service.handleEmailConfirmationCallback(
    { url: '/auth/confirm?attempt=not-the-nonce&code=attacker-code' },
    silentResponse(),
  ), true)

  assert.equal(seen.exchanges, 0, 'a mismatched nonce must not reach the exchange')
  assert.equal(stored(), '')
  assert.equal(service.getCachedSnapshot().session.status, 'signed-out')
  assert.deepEqual(emailConfirmations, [], 'another attempt must not be resolved by this one')
})

test('a session for a different address is refused', async () => {
  // The exchange succeeds but returns someone else. Accepting it would let a
  // link issued for one account establish a session for another.
  const otherUser = { ...verifiedUser, id: '00000000-0000-4000-8000-0000000000ff', email: 'someone.else@example.com' }
  const seen = { signupRedirect: null }
  const fetchImpl = async (target, options = {}) => {
    if (target.includes('/auth/v1/signup')) {
      seen.signupRedirect = new URL(target).searchParams.get('redirect_to')
      return jsonResponse({ id: verifiedUser.id, email: verifiedUser.email })
    }
    if (target.includes('/auth/v1/token?grant_type=pkce')) {
      return jsonResponse({
        access_token: 'other-access-token',
        refresh_token: 'other-refresh-token',
        expires_in: 3600,
        user: otherUser,
      })
    }
    if (target.endsWith('/auth/v1/user')) return jsonResponse(otherUser)
    throw new Error(`Unexpected request: ${target}`)
  }
  const { service, emailConfirmations, stored } = configuredService(fetchImpl)

  await service.signUp({ email: verifiedUser.email, password: 'a-long-enough-password' })
  const nonce = new URL(seen.signupRedirect).searchParams.get('attempt')

  assert.equal(await service.handleEmailConfirmationCallback(
    { url: `/auth/confirm?attempt=${encodeURIComponent(nonce)}&code=emailed-code` },
    silentResponse(),
  ), true)

  assert.equal(stored(), '', 'no session may be persisted for a mismatched address')
  assert.equal(service.getCachedSnapshot().session.status, 'signed-out')
  assert.equal(emailConfirmations.at(-1).state, 'confirmed')
})

test('the link is single use', async () => {
  const { fetchImpl, seen } = confirmationHarness(confirmedSession)
  const { service } = configuredService(fetchImpl)

  await service.signUp({ email: verifiedUser.email, password: 'a-long-enough-password' })
  const nonce = new URL(seen.signupRedirect).searchParams.get('attempt')
  const url = `/auth/confirm?attempt=${encodeURIComponent(nonce)}&code=emailed-code`

  await service.handleEmailConfirmationCallback({ url }, silentResponse())
  await service.handleEmailConfirmationCallback({ url }, silentResponse())

  assert.equal(seen.exchanges, 1, 'replaying the link must not exchange the code twice')
})

test('a confirmation with nothing pending reports success rather than an error', async () => {
  // Supabase verifies the token and marks the address confirmed BEFORE it
  // redirects. Arriving with no attempt — app restarted, window lapsed, link
  // opened twice — means the account IS confirmed and only the automatic
  // sign-in was lost. Reporting failure would be actively wrong.
  const { fetchImpl, seen } = confirmationHarness(confirmedSession)
  const { service, emailConfirmations } = configuredService(fetchImpl)

  const captured = { status: 0, body: '' }
  const response = {
    writeHead(status) { captured.status = status },
    end(body) { captured.body = String(body) },
  }

  assert.equal(await service.handleEmailConfirmationCallback(
    { url: '/auth/confirm?attempt=orphaned&code=emailed-code' },
    response,
  ), true)

  assert.equal(seen.exchanges, 0)
  assert.equal(captured.status, 200)
  assert.match(captured.body, /confirmed/i)
  assert.doesNotMatch(captured.body, /invalid|failed/i)
  assert.deepEqual(emailConfirmations, [])
})

test('a build with no loopback callback still signs up, without a redirect', async () => {
  // The confirmation flow is additive: an unconfigured build must behave
  // exactly as it did before rather than refusing to create accounts.
  const { fetchImpl, seen } = confirmationHarness(confirmedSession)
  const { service } = configuredService(fetchImpl, { confirmCallbackUrl: '' })

  const result = await service.signUp({ email: verifiedUser.email, password: 'a-long-enough-password' })
  assert.equal(result.ok, true)
  assert.equal(seen.signupRedirect, null)
  assert.equal(seen.signupBody.code_challenge, undefined)
})

test('the confirmation handler ignores a path that is not its own', async () => {
  const { fetchImpl } = confirmationHarness(confirmedSession)
  const { service } = configuredService(fetchImpl)
  assert.equal(
    await service.handleEmailConfirmationCallback({ url: '/auth/recovery?attempt=x&code=y' }, silentResponse()),
    false,
  )
})
