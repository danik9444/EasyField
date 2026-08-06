/**
 * Admin console data layer.
 *
 * Every privileged read and write goes to the easyfield-admin edge function
 * with the operator's own Supabase session token. Nothing here holds a
 * service-role key, and nothing here talks to PostgREST directly: an ordinary
 * authenticated session reaches the database as `authenticated`, which the
 * schema revokes from every admin function on purpose.
 *
 * When no API base URL is configured the module serves fixtures instead, so the
 * whole console can be developed and tested before a backend exists. Fixture
 * mode is visible in the UI rather than silent — a console that invents numbers
 * without saying so is worse than one that refuses to load.
 */

import { FIXTURES } from './fixtures'

export interface AdminConfig {
  readonly apiBaseUrl: string
  readonly supabaseUrl: string
  readonly supabaseAnonKey: string
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/**
 * Reads deployment configuration from build-time environment variables.
 *
 * Only the anon key is ever read here. It is a publishable key by design; the
 * service-role key has no legitimate path into a browser bundle, so there is
 * deliberately no variable for it to arrive through.
 */
export function readConfig(): AdminConfig {
  const env = import.meta.env as Record<string, string | undefined>
  return {
    apiBaseUrl: trimTrailingSlash((env.VITE_ADMIN_API_URL ?? '').trim()),
    supabaseUrl: trimTrailingSlash((env.VITE_SUPABASE_URL ?? '').trim()),
    supabaseAnonKey: (env.VITE_SUPABASE_ANON_KEY ?? '').trim(),
  }
}

export function isFixtureMode(config: AdminConfig): boolean {
  return config.apiBaseUrl === '' || config.supabaseUrl === '' || config.supabaseAnonKey === ''
}

export class AdminApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'AdminApiError'
  }
}

export interface Session {
  readonly accessToken: string
  readonly email: string
  readonly expiresAt: number
}

/**
 * Exchanges a password for a Supabase session.
 *
 * The resulting token is held in memory by the caller and never written to
 * localStorage. An admin console is a high-value target, and a token that does
 * not outlive the page cannot be stolen from storage later.
 */
export async function signIn(
  config: AdminConfig,
  email: string,
  password: string,
): Promise<Session> {
  if (isFixtureMode(config)) {
    return { accessToken: 'fixture', email, expiresAt: Date.now() + 3_600_000 }
  }

  const response = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: config.supabaseAnonKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  })

  if (!response.ok) {
    // The provider distinguishes "no such user" from "wrong password"; the
    // console does not repeat that distinction back to the screen.
    throw new AdminApiError(response.status, 'Sign-in failed. Check the email and password.')
  }

  const payload = (await response.json()) as {
    access_token?: unknown
    expires_in?: unknown
    user?: { email?: unknown }
  }

  if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
    throw new AdminApiError(502, 'The sign-in response was not understood.')
  }

  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 3600
  return {
    accessToken: payload.access_token,
    email: typeof payload.user?.email === 'string' ? payload.user.email : email,
    expiresAt: Date.now() + expiresIn * 1000,
  }
}

/**
 * Raised when the operator's session is no longer accepted — expired, revoked,
 * or the account demoted. Distinguished from an ordinary failure because the
 * remedy is different: retrying will never work, only signing in again will.
 */
export class SessionEndedError extends AdminApiError {
  constructor(status: number, message: string) {
    super(status, message)
    this.name = 'SessionEndedError'
  }
}

async function request<T>(
  config: AdminConfig,
  session: Session,
  path: string,
  init?: RequestInit,
  onSessionEnded?: () => void,
): Promise<T> {
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      authorization: `Bearer ${session.accessToken}`,
      accept: 'application/json',
    },
  })

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : 'The admin service returned an error.'

    // A 401 means the token is gone; a 403 means this account is no longer an
    // admin, which is what an operator sees the instant someone demotes them.
    // Both end the session. Polling through them would leave a full, plausible
    // screen that quietly stopped updating — the worst outcome during an
    // incident, because nothing looks wrong.
    if (response.status === 401 || response.status === 403) {
      onSessionEnded?.()
      throw new SessionEndedError(
        response.status,
        response.status === 401
          ? 'Your session has expired. Sign in again.'
          : 'This account no longer has platform admin access.',
      )
    }

    throw new AdminApiError(response.status, message)
  }

  return payload as T
}

export interface Overview {
  generatedAt: string
  users: { total: number; customers: number; support: number; admins: number }
  subscriptions: Record<string, number>
  credits: {
    availableMicrocredits: string
    reservedMicrocredits: string
    lifetimeGrantedMicrocredits: string
    lifetimeConsumedMicrocredits: string
  }
  checkouts: Record<string, number>
}

export interface AdminUser {
  userId: string
  email: string | null
  platformRole: 'customer' | 'support' | 'admin'
  createdAt: string
  emailConfirmed: boolean
  banned: boolean
  deleted: boolean
  availableMicrocredits: string
  subscriptionStatus: string | null
  planKey: string | null
}

export interface UserDetail {
  profile: {
    userId: string
    email: string | null
    platformRole: string
    createdAt: string
    emailConfirmed: boolean
    banned: boolean
    deleted: boolean
    lastSignInAt: string | null
  }
  creditAccount: {
    availableMicrocredits: string
    reservedMicrocredits: string
    lifetimeGrantedMicrocredits: string
    lifetimeConsumedMicrocredits: string
    lifetimeExpiredMicrocredits: string
    updatedAt: string
  } | null
  subscriptions: Array<{
    id: string
    planKey: string
    billingInterval: string
    status: string
    currentPeriodStart: string | null
    currentPeriodEnd: string | null
    cancelAtPeriodEnd: boolean
    unitAmountCurrencyMicros: string
    currencyCode: string
  }>
  autoReload: { enabled: boolean; planKey: string | null } | null
  partnerEntitlement: { status: string; offerKey: string; lifetimeAccess: boolean } | null
  roleHistory: Array<{
    id: string
    previousRole: string | null
    newRole: string
    reason: string
    actorUserId: string | null
    createdAt: string
  }>
}

export interface MaintenanceJob {
  job: string
  everRan: boolean
  lastRunAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  processedLastRun: number | null
  /** The job has not succeeded within its own cadence. */
  stale: boolean
}

export interface OperationalAlert {
  severity: 'critical' | 'warning'
  code: string
  count: number
  message: string
}

export interface BlockedRenewal {
  subscriptionId: string
  planKey: string
  billingInterval: string
  periodEndsAt: string
  reason: string
}

export interface AutoReloadDue {
  accountId: string
  planKey: string | null
  availableMicrocredits: string
  triggerBelowMicrocredits: string
  reloadMicrocredits: string
  hasSavedMethod: boolean
}

export interface Incidents {
  /**
   * Everything currently wrong, in one list. Optional along with the other
   * additions below because a console that crashes against a backend one
   * migration behind is worse than one that shows a little less.
   */
  alerts?: OperationalAlert[]
  /** Subscriptions that will lapse because nothing can charge them. */
  blockedRenewals?: BlockedRenewal[]
  /** Accounts past their auto-reload threshold with no worker to act. */
  autoReloadDue?: AutoReloadDue[]
  maintenance?: MaintenanceJob[]
  ambiguousCheckouts: Array<{ id: string; intentType: string; status: string; updatedAt: string }>
  openCheckouts: Array<{ id: string; intentType: string; status: string; createdAt: string }>
  unresolvedRenewals: Array<{ id: string; planKey: string; state: string; createdAt: string }>
  pendingGrants: Array<{ id: string; status: string; grantNumber: number; scheduledFor: string }>
}

export interface AuditPage {
  /** The server-applied page size. A full page means more may exist. */
  limit?: number
  entries: Array<{
    id: string
    targetUserId: string
    targetEmail: string | null
    actorUserId: string | null
    actorEmail: string | null
    previousRole: string | null
    newRole: string
    reason: string
    createdAt: string
  }>
}

export interface CreditDetail {
  limit?: number
  lots: Array<{
    id: string
    sourceType: string
    totalMicrocredits: string
    availableMicrocredits: string
    grantedAt: string
    expiresAt: string | null
  }>
  ledger: Array<{
    id: string
    entryType: string
    availableDeltaMicrocredits: string
    consumedDeltaMicrocredits: string
    referenceType: string | null
    createdAt: string
  }>
}

export interface AdminApi {
  overview(): Promise<Overview>
  users(query: { search?: string; role?: string; limit?: number }): Promise<{ users: AdminUser[] }>
  userDetail(userId: string): Promise<UserDetail>
  credits(userId: string, cursor?: string): Promise<CreditDetail>
  incidents(): Promise<Incidents>
  audit(cursor?: string): Promise<AuditPage>
  setRole(input: {
    requestId: string
    targetUserId: string
    newRole: string
    reason: string
  }): Promise<{ userId: string; platformRole: string }>
}

export function createApi(
  config: AdminConfig,
  session: Session,
  onSessionEnded?: () => void,
): AdminApi {
  if (isFixtureMode(config)) return createFixtureApi()

  return {
    overview: () => request(config, session, '/overview', undefined, onSessionEnded),
    users: (query) => {
      const params = new URLSearchParams()
      if (query.search) params.set('search', query.search)
      if (query.role) params.set('role', query.role)
      if (query.limit) params.set('limit', String(query.limit))
      const suffix = params.toString()
      return request(config, session, `/users${suffix ? `?${suffix}` : ''}`)
    },
    userDetail: (userId) => request(config, session, `/users/${userId}`, undefined, onSessionEnded),
    credits: (userId, cursor) => request(config, session, `/users/${userId}/credits` + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''), undefined, onSessionEnded),
    incidents: () => request(config, session, '/incidents', undefined, onSessionEnded),
    audit: (cursor) => request(config, session, '/audit' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''), undefined, onSessionEnded),
    setRole: (input) =>
      request(config, session, '/roles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }, onSessionEnded),
  }
}

/**
 * Fixture-backed implementation. Mutations update the in-memory copy so the
 * console's write paths can be exercised end to end without a backend, and the
 * same validation errors surface as the real API would raise.
 */
function createFixtureApi(): AdminApi {
  const users = FIXTURES.users.map((user) => ({ ...user }))
  const audit = FIXTURES.audit.entries.map((entry) => ({ ...entry }))
  let nextAuditId = 1000

  const settle = <T,>(value: T): Promise<T> =>
    new Promise((resolve) => setTimeout(() => resolve(value), 120))

  return {
    overview: () =>
      settle({
        ...FIXTURES.overview,
        generatedAt: new Date().toISOString(),
        users: {
          total: users.length,
          customers: users.filter((u) => u.platformRole === 'customer').length,
          support: users.filter((u) => u.platformRole === 'support').length,
          admins: users.filter((u) => u.platformRole === 'admin').length,
        },
      }),
    users: (query) => {
      const search = query.search?.trim().toLowerCase() ?? ''
      return settle({
        users: users.filter((user) => {
          if (query.role && user.platformRole !== query.role) return false
          if (!search) return true
          return (user.email ?? '').toLowerCase().includes(search) || user.userId === search
        }),
      })
    },
    userDetail: (userId) => {
      const detail = FIXTURES.details[userId]
      if (!detail) return Promise.reject(new AdminApiError(404, 'Not found'))
      const current = users.find((user) => user.userId === userId)
      return settle({
        ...detail,
        profile: { ...detail.profile, platformRole: current?.platformRole ?? detail.profile.platformRole },
        roleHistory: audit
          .filter((entry) => entry.targetUserId === userId)
          .map(({ id, previousRole, newRole, reason, actorUserId, createdAt }) => ({
            id,
            previousRole,
            newRole,
            reason,
            actorUserId,
            createdAt,
          })),
      })
    },
    credits: (userId, _cursor?: string) =>
      settle(FIXTURES.credits[userId] ?? { lots: [], ledger: [] }),
    incidents: () => settle(FIXTURES.incidents),
    audit: (_cursor?: string) => settle({ entries: [...audit].sort((a, b) => Number(b.id) - Number(a.id)) }),
    setRole: (input) => {
      const target = users.find((user) => user.userId === input.targetUserId)
      if (!target) return Promise.reject(new AdminApiError(404, 'Not found'))

      // Mirrors the last-admin guard in billing_private.set_platform_role, so
      // the fixture cannot demonstrate a state the database would refuse.
      const admins = users.filter((user) => user.platformRole === 'admin')
      if (target.platformRole === 'admin' && input.newRole !== 'admin' && admins.length <= 1) {
        return Promise.reject(new AdminApiError(400, 'The final platform admin cannot be demoted'))
      }

      const previousRole = target.platformRole
      target.platformRole = input.newRole as AdminUser['platformRole']
      audit.unshift({
        id: String(nextAuditId++),
        targetUserId: target.userId,
        targetEmail: target.email,
        actorUserId: FIXTURES.actorUserId,
        actorEmail: FIXTURES.actorEmail,
        previousRole,
        newRole: input.newRole,
        reason: input.reason,
        createdAt: new Date().toISOString(),
      })
      return settle({ userId: target.userId, platformRole: target.platformRole })
    },
  }
}
