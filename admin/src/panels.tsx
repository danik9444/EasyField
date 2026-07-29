import { useMemo, useState } from 'react'
import type { AdminApi, AdminUser, AuditPage, MaintenanceJob, OperationalAlert } from './api'
import { AdminApiError } from './api'
import { formatAge, formatCount, formatCredits, formatDateTime, formatMoney, shortId } from './format'
import { POLL, useLiveData, type LiveState } from './useLiveData'

function Freshness({ state, paused }: { state: LiveState<unknown>; paused: boolean }) {
  const label =
    state.status === 'loading'
      ? 'loading…'
      : paused
        ? `paused · ${formatAge(state.updatedAt)}`
        : formatAge(state.updatedAt)
  return (
    <span className={`freshness${state.status === 'stale' ? ' is-stale' : ''}`} role="status">
      <span className={`dot${paused ? ' is-paused' : ''}`} aria-hidden="true" />
      {label}
    </span>
  )
}

function PanelHeader({
  title,
  state,
  paused,
  onRefresh,
  children,
}: {
  title: string
  state: LiveState<unknown>
  paused: boolean
  onRefresh: () => void
  children?: React.ReactNode
}) {
  return (
    <header className="panel-head">
      <h2>{title}</h2>
      <div className="panel-head-tools">
        {children}
        <Freshness state={state} paused={paused} />
        <button type="button" className="ghost" onClick={onRefresh}>Refresh</button>
      </div>
    </header>
  )
}

/**
 * A failed poll keeps the previous values on screen. The banner explains why
 * they stopped moving, because silently frozen numbers are how an operator ends
 * up acting on data that is an hour old.
 */
function StaleBanner({ state }: { state: LiveState<unknown> }) {
  if (state.status !== 'stale') return null
  return (
    <div className="banner is-error" role="alert">
      <strong>Refresh failed.</strong> {state.error}
      {state.updatedAt !== null && <> Showing data from {formatAge(state.updatedAt)}.</>}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'good' }) {
  return (
    <div className={`stat${tone ? ` is-${tone}` : ''}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  )
}

export function OverviewPanel({ api }: { api: AdminApi }) {
  const { state, refresh, paused } = useLiveData(() => api.overview(), POLL.medium)

  return (
    <section className="panel">
      <PanelHeader title="Overview" state={state} paused={paused} onRefresh={refresh} />
      <StaleBanner state={state} />
      {state.data === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="stat-grid">
            <Stat label="Users" value={formatCount(state.data.users.total)} />
            <Stat label="Customers" value={formatCount(state.data.users.customers)} />
            <Stat label="Support" value={formatCount(state.data.users.support)} />
            <Stat label="Admins" value={formatCount(state.data.users.admins)} />
          </div>

          <h3>Credits outstanding</h3>
          <div className="stat-grid">
            <Stat label="Available" value={formatCredits(state.data.credits.availableMicrocredits)} />
            <Stat label="Reserved" value={formatCredits(state.data.credits.reservedMicrocredits)} />
            <Stat label="Granted (lifetime)" value={formatCredits(state.data.credits.lifetimeGrantedMicrocredits)} />
            <Stat label="Consumed (lifetime)" value={formatCredits(state.data.credits.lifetimeConsumedMicrocredits)} />
          </div>

          <div className="split">
            <div>
              <h3>Subscriptions</h3>
              <TallyList tally={state.data.subscriptions} />
            </div>
            <div>
              <h3>Checkouts</h3>
              <TallyList tally={state.data.checkouts} />
            </div>
          </div>
        </>
      )}
    </section>
  )
}

function TallyList({ tally }: { tally: Record<string, number> }) {
  const rows = Object.entries(tally)
  if (rows.length === 0) return <p className="muted">None recorded.</p>
  return (
    <ul className="tally">
      {rows
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => (
          <li key={key}>
            <span className={`pill status-${key}`}>{key.replace(/_/g, ' ')}</span>
            <strong>{formatCount(count)}</strong>
          </li>
        ))}
    </ul>
  )
}

export function UsersPanel({
  api,
  onOpenUser,
}: {
  api: AdminApi
  onOpenUser: (userId: string) => void
}) {
  const [search, setSearch] = useState('')
  const [role, setRole] = useState('')
  // Committed separately from the input so typing does not fire a request per
  // keystroke, and so the poll keeps using the query the operator settled on.
  const [committed, setCommitted] = useState({ search: '', role: '' })

  const { state, refresh, paused } = useLiveData(
    () => api.users({ search: committed.search || undefined, role: committed.role || undefined, limit: 50 }),
    POLL.medium,
    [committed.search, committed.role],
  )

  return (
    <section className="panel">
      <PanelHeader title="Users" state={state} paused={paused} onRefresh={refresh}>
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault()
            setCommitted({ search: search.trim(), role })
          }}
        >
          <input
            type="search"
            value={search}
            placeholder="Email or user id"
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search users"
          />
          <select value={role} onChange={(event) => setRole(event.target.value)} aria-label="Filter by role">
            <option value="">All roles</option>
            <option value="customer">Customer</option>
            <option value="support">Support</option>
            <option value="admin">Admin</option>
          </select>
          <button type="submit">Search</button>
        </form>
      </PanelHeader>
      <StaleBanner state={state} />

      {state.data === null ? (
        <p className="muted">Loading…</p>
      ) : state.data.users.length === 0 ? (
        <p className="muted">No users match that query.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th className="numeric">Credits</th>
                <th>Plan</th>
                <th>Joined</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state.data.users.map((user) => (
                <tr key={user.userId}>
                  <td>
                    <span className="mono">{user.email ?? shortId(user.userId)}</span>
                  </td>
                  <td><span className={`pill role-${user.platformRole}`}>{user.platformRole}</span></td>
                  <td><AccountFlags user={user} /></td>
                  <td className="numeric">{formatCredits(user.availableMicrocredits)}</td>
                  <td>
                    {user.subscriptionStatus
                      ? <span className={`pill status-${user.subscriptionStatus}`}>{user.planKey ?? '—'}</span>
                      : <span className="muted">none</span>}
                  </td>
                  <td className="muted">{formatDateTime(user.createdAt)}</td>
                  <td>
                    <button type="button" className="ghost" onClick={() => onOpenUser(user.userId)}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function AccountFlags({ user }: { user: AdminUser }) {
  if (user.deleted) return <span className="pill is-bad">deleted</span>
  if (user.banned) return <span className="pill is-bad">banned</span>
  if (!user.emailConfirmed) return <span className="pill is-warn">unverified</span>
  return <span className="pill is-good">active</span>
}

export function UserDetailPanel({
  api,
  userId,
  actorEmail,
  onBack,
}: {
  api: AdminApi
  userId: string
  actorEmail: string
  onBack: () => void
}) {
  const { state, refresh, paused } = useLiveData(() => api.userDetail(userId), POLL.medium, [userId])
  const credits = useLiveData(() => api.credits(userId), POLL.slow, [userId])
  const creditLots = credits.state.data?.lots ?? []

  return (
    <section className="panel">
      <PanelHeader title="User" state={state} paused={paused} onRefresh={refresh}>
        <button type="button" className="ghost" onClick={onBack}>← Users</button>
      </PanelHeader>
      <StaleBanner state={state} />

      {state.data === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="detail-head">
            <div>
              <h3 className="mono">{state.data.profile.email ?? state.data.profile.userId}</h3>
              <p className="muted mono">{state.data.profile.userId}</p>
            </div>
            <span className={`pill role-${state.data.profile.platformRole}`}>
              {state.data.profile.platformRole}
            </span>
          </div>

          <div className="stat-grid">
            <Stat label="Available credits" value={formatCredits(state.data.creditAccount?.availableMicrocredits)} />
            <Stat label="Reserved" value={formatCredits(state.data.creditAccount?.reservedMicrocredits)} />
            <Stat label="Consumed (lifetime)" value={formatCredits(state.data.creditAccount?.lifetimeConsumedMicrocredits)} />
            <Stat label="Last sign-in" value={formatDateTime(state.data.profile.lastSignInAt)} />
          </div>

          <h3>Subscriptions</h3>
          {state.data.subscriptions.length === 0 ? (
            <p className="muted">No subscriptions.</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th>Plan</th><th>Interval</th><th>Status</th><th className="numeric">Amount</th><th>Period ends</th></tr>
                </thead>
                <tbody>
                  {state.data.subscriptions.map((subscription) => (
                    <tr key={subscription.id}>
                      <td>{subscription.planKey}</td>
                      <td>{subscription.billingInterval}</td>
                      <td><span className={`pill status-${subscription.status}`}>{subscription.status}</span></td>
                      <td className="numeric">{formatMoney(subscription.unitAmountCurrencyMicros)}</td>
                      <td className="muted">{formatDateTime(subscription.currentPeriodEnd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* These four were fetched and discarded. Each answers a question
              an operator actually asks: why does this account have access
              with no subscription (partner), will they be charged again
              (auto-reload), when does their credit lapse (lots), and who
              last changed their role and why (history). */}
          {(state.data.partnerEntitlement || state.data.autoReload) && (
            <>
              <h3>Entitlements</h3>
              <ul className="tally">
                {state.data.partnerEntitlement && (
                  <li>
                    <span className="pill role-admin">partner</span>
                    <span className="muted small">
                      {state.data.partnerEntitlement.offerKey}
                      {state.data.partnerEntitlement.lifetimeAccess ? ' · lifetime' : ''}
                    </span>
                    <span className={`pill status-${state.data.partnerEntitlement.status}`}>
                      {state.data.partnerEntitlement.status}
                    </span>
                  </li>
                )}
                {state.data.autoReload && (
                  <li>
                    <span className="pill">auto-reload</span>
                    <span className="muted small">{state.data.autoReload.planKey ?? "—"}</span>
                    <span className={`pill ${state.data.autoReload.enabled ? "is-warn" : ""}`}>
                      {state.data.autoReload.enabled ? "enabled" : "off"}
                    </span>
                  </li>
                )}
              </ul>
            </>
          )}

          {creditLots.length > 0 && (
            <>
              <h3>Credit grant lots</h3>
              <p className="muted small">
                Where a balance came from, and when it lapses. Credit expires per lot, so a
                customer with a healthy total can still be about to lose most of it.
              </p>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr><th>Source</th><th className="numeric">Granted</th><th className="numeric">Remaining</th><th>Expires</th></tr>
                  </thead>
                  <tbody>
                    {creditLots.map((lot) => (
                      <tr key={lot.id}>
                        <td><span className="pill">{lot.sourceType}</span></td>
                        <td className="numeric">{formatCredits(lot.totalMicrocredits)}</td>
                        <td className="numeric">{formatCredits(lot.availableMicrocredits)}</td>
                        <td className="muted">{formatDateTime(lot.expiresAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {state.data.roleHistory.length > 0 && (
            <>
              <h3>Role history for this account</h3>
              <ul className="incident-list">
                {state.data.roleHistory.map((entry) => (
                  <li key={entry.id}>
                    <span className="muted small">{formatDateTime(entry.createdAt)}</span>
                    <span className="pill">{entry.previousRole ?? "none"}</span>
                    <span>→</span>
                    <span className={`pill role-${entry.newRole}`}>{entry.newRole}</span>
                    <span className="muted small">{entry.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <RoleControl
            api={api}
            userId={userId}
            currentRole={state.data.profile.platformRole}
            email={state.data.profile.email}
            actorEmail={actorEmail}
            onChanged={refresh}
          />

          <h3>Credit ledger</h3>
          <p className="muted small">
            The ledger is append-only and protected by a database trigger. This console reads it as
            evidence and has no path to change it.
          </p>
          {/* This is the table an operator quotes back during a billing dispute.
              A silent "Loading…" that never resolves is worse here than
              anywhere else on the screen, so its failure state is explicit. */}
          <StaleBanner state={credits.state} />
          {credits.state.status === 'stale' && credits.state.data === null ? (
            <p className="muted">The ledger could not be loaded.</p>
          ) : credits.state.data === null ? (
            <p className="muted">Loading…</p>
          ) : credits.state.data.ledger.length === 0 ? (
            <p className="muted">No ledger entries.</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th>Entry</th><th className="numeric">Available Δ</th><th className="numeric">Consumed Δ</th><th>Reference</th><th>When</th></tr>
                </thead>
                <tbody>
                  {credits.state.data.ledger.map((entry) => (
                    <tr key={entry.id}>
                      <td><span className="pill">{entry.entryType}</span></td>
                      <td className="numeric">{formatCredits(entry.availableDeltaMicrocredits)}</td>
                      <td className="numeric">{formatCredits(entry.consumedDeltaMicrocredits)}</td>
                      <td className="muted">{entry.referenceType ?? '—'}</td>
                      <td className="muted">{formatDateTime(entry.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}

/**
 * The console's only write.
 *
 * Everything enforced here is enforced again by the database:
 * billing_private.set_platform_role takes the mutation lock, requires the same
 * reason bounds, and refuses to demote the final admin. The UI copy exists to
 * make the operator deliberate, not to be the guarantee.
 */
function RoleControl({
  api,
  userId,
  currentRole,
  email,
  actorEmail,
  onChanged,
}: {
  api: AdminApi
  userId: string
  currentRole: string
  email: string | null
  actorEmail: string
  onChanged: () => void
}) {
  const [nextRole, setNextRole] = useState(currentRole)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const isSelf = email !== null && email === actorEmail
  const changed = nextRole !== currentRole
  const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 500
  const escalating = nextRole === 'admin' && currentRole !== 'admin'

  const requestId = useMemo(() => crypto.randomUUID(), [userId, currentRole, done])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!changed || !reasonOk || busy) return
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      await api.setRole({ requestId, targetUserId: userId, newRole: nextRole, reason: reason.trim() })
      setDone(`Role changed to ${nextRole}.`)
      setReason('')
      onChanged()
    } catch (caught) {
      setError(caught instanceof AdminApiError ? caught.message : 'The role change failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="danger-zone" onSubmit={submit}>
      <h3>Platform role</h3>
      <p className="muted small">
        Every change is written to an immutable audit trail with the reason below. The final
        remaining admin cannot be demoted.
      </p>

      {isSelf && (
        <div className="banner is-warn">
          This is your own account. Removing your admin access is refused.
        </div>
      )}

      <div className="inline-form">
        <select
          value={nextRole}
          onChange={(event) => setNextRole(event.target.value)}
          aria-label="New platform role"
          disabled={busy}
        >
          <option value="customer">customer</option>
          <option value="support">support</option>
          <option value="admin">admin</option>
        </select>
        <input
          type="text"
          value={reason}
          placeholder="Reason (required, 3–500 characters)"
          onChange={(event) => setReason(event.target.value)}
          disabled={busy}
          aria-label="Reason for the role change"
        />
        <button type="submit" className="danger" disabled={!changed || !reasonOk || busy}>
          {busy ? 'Applying…' : 'Change role'}
        </button>
      </div>

      {escalating && changed && (
        <div className="banner is-warn">
          <strong>This grants full platform administration.</strong> The account will be able to read
          every customer record and change any role, including yours.
        </div>
      )}
      {error && <div className="banner is-error" role="alert">{error}</div>}
      {done && <div className="banner is-good" role="status">{done}</div>}
    </form>
  )
}

export function IncidentsPanel({ api }: { api: AdminApi }) {
  const { state, refresh, paused } = useLiveData(() => api.incidents(), POLL.fast)

  return (
    <section className="panel">
      <PanelHeader title="Incidents" state={state} paused={paused} onRefresh={refresh} />
      <StaleBanner state={state} />
      <p className="muted small">
        Work that stopped progressing. Nothing here is settled from this console — a checkout that
        may have taken money is resolved with provider evidence, never by marking it paid.
      </p>

      {state.data?.alerts && state.data.alerts.length > 0 && (
        <AlertList alerts={state.data.alerts} />
      )}
      {state.data?.maintenance && <MaintenanceHealth jobs={state.data.maintenance} />}
      {state.data?.blockedRenewals && state.data.blockedRenewals.length > 0 && (
        <WaitingOnProvider
          title="Renewals that cannot be charged"
          hint="These subscriptions end soon with no usable payment method. Nothing can renew them, so they will lapse."
          rows={state.data.blockedRenewals.map((row) => ({
            key: row.subscriptionId,
            primary: `${row.planKey} · ${row.billingInterval}`,
            secondary: row.reason,
            when: row.periodEndsAt,
          }))}
        />
      )}
      {state.data?.autoReloadDue && state.data.autoReloadDue.length > 0 && (
        <WaitingOnProvider
          title="Auto-reload triggered"
          hint="These accounts are below their reload threshold. The setting is saved; no worker charges it yet."
          rows={state.data.autoReloadDue.map((row) => ({
            key: row.accountId,
            primary: `${formatCredits(row.availableMicrocredits)} left, reload ${formatCredits(row.reloadMicrocredits)}`,
            secondary: row.hasSavedMethod ? 'has saved method' : 'no saved method',
            when: null,
          }))}
        />
      )}

      {state.data === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="incident-grid">
          <IncidentList
            title="Ambiguous checkouts"
            hint="Failed, expired or cancelled — may still prove paid."
            rows={state.data.ambiguousCheckouts.map((row) => ({
              id: row.id,
              primary: row.intentType,
              secondary: row.status,
              when: row.updatedAt,
            }))}
          />
          <IncidentList
            title="Open checkouts"
            hint="Started and not yet terminal."
            rows={state.data.openCheckouts.map((row) => ({
              id: row.id,
              primary: row.intentType,
              secondary: row.status,
              when: row.createdAt,
            }))}
          />
          <IncidentList
            title="Unresolved renewals"
            hint="Scheduled or mid-charge."
            rows={state.data.unresolvedRenewals.map((row) => ({
              id: row.id,
              primary: row.planKey,
              secondary: row.state,
              when: row.createdAt,
            }))}
          />
          <IncidentList
            title="Pending grants"
            hint="Annual credit instalments due."
            rows={state.data.pendingGrants.map((row) => ({
              id: row.id,
              primary: `grant ${row.grantNumber}`,
              secondary: row.status,
              when: row.scheduledFor,
            }))}
          />
        </div>
      )}
    </section>
  )
}

/**
 * Everything currently wrong, above everything else.
 *
 * The queues below answer "what is in this state"; this answers "what should I
 * be doing right now", which is the only question an operator has when they
 * open this screen at speed.
 */
function AlertList({ alerts }: { alerts: OperationalAlert[] }) {
  const ordered = [...alerts].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1,
  )
  return (
    <div style={{ marginTop: 14 }}>
      {ordered.map((alert) => (
        <div
          key={alert.code}
          className={`banner ${alert.severity === 'critical' ? 'is-error' : 'is-warn'}`}
          role={alert.severity === 'critical' ? 'alert' : 'status'}
        >
          <strong>{alert.count}</strong> · {alert.message}
        </div>
      ))}
    </div>
  )
}

/**
 * Work that is understood, enqueued, and cannot proceed without a payment
 * provider. Kept visually distinct from failures: nothing here is broken, and
 * presenting it as an error would train the operator to ignore real ones.
 */
function WaitingOnProvider({
  title,
  hint,
  rows,
}: {
  title: string
  hint: string
  rows: Array<{ key: string; primary: string; secondary: string; when: string | null }>
}) {
  return (
    <div className="incident-card has-items" style={{ marginTop: 12 }}>
      <h3>
        {title} <span className="count">{rows.length}</span>
      </h3>
      <p className="muted small">{hint}</p>
      <ul className="incident-list">
        {rows.map((row) => (
          <li key={row.key}>
            <span className="mono small">{shortId(row.key)}</span>
            <span>{row.primary}</span>
            <span className="pill is-warn">{row.secondary}</span>
            {row.when && <span className="muted small">{formatDateTime(row.when)}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Scheduler health.
 *
 * Placed first, and loud when stale, because a stopped scheduler makes every
 * other panel lie: with nothing expiring credit lots or releasing reservations,
 * the queues below stay empty and the system looks calm while annual customers
 * quietly stop receiving the instalments they paid for.
 */
function MaintenanceHealth({ jobs }: { jobs: MaintenanceJob[] }) {
  const stale = jobs.filter((job) => job.stale)
  const failing = jobs.filter((job) => job.lastError !== null)

  return (
    <div className={`incident-card${stale.length > 0 ? ' has-items' : ''}`} style={{ marginTop: 14 }}>
      <h3>
        Scheduled maintenance
        <span className="count">{stale.length > 0 ? `${stale.length} stale` : 'healthy'}</span>
      </h3>

      {stale.length > 0 && (
        <div className="banner is-error" role="alert">
          <strong>
            {stale.length === jobs.length
              ? 'No maintenance job has run recently.'
              : `${stale.length} of ${jobs.length} maintenance jobs are overdue.`}
          </strong>{' '}
          Annual credit instalments, credit expiry and reservation release all depend on these. While
          they are stopped, balances drift and paid-for credit does not arrive.
        </div>
      )}
      {failing.length > 0 && (
        <div className="banner is-error" role="alert">
          <strong>Last run failed:</strong> {failing[0].lastError}
        </div>
      )}

      <ul className="incident-list">
        {jobs.map((job) => (
          <li key={job.job}>
            <span className={`pill ${job.stale ? 'is-bad' : 'is-good'}`}>
              {job.stale ? 'stale' : 'ok'}
            </span>
            <span className="mono small">{job.job}</span>
            <span className="muted small">
              {job.everRan ? `last ok ${formatAge(toEpoch(job.lastSuccessAt))}` : 'never ran'}
            </span>
            {job.processedLastRun !== null && (
              <span className="muted small">· {formatCount(job.processedLastRun)} processed</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function toEpoch(value: string | null): number | null {
  if (!value) return null
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

function IncidentList({
  title,
  hint,
  rows,
}: {
  title: string
  hint: string
  rows: Array<{ id: string; primary: string; secondary: string; when: string }>
}) {
  return (
    <div className={`incident-card${rows.length > 0 ? ' has-items' : ''}`}>
      <h3>
        {title} <span className="count">{rows.length}</span>
      </h3>
      <p className="muted small">{hint}</p>
      {rows.length === 0 ? (
        <p className="muted small">Clear.</p>
      ) : (
        <ul className="incident-list">
          {rows.map((row) => (
            <li key={row.id}>
              <span className="mono small">{shortId(row.id)}</span>
              <span>{row.primary}</span>
              <span className={`pill status-${row.secondary}`}>{row.secondary}</span>
              <span className="muted small">{formatDateTime(row.when)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function AuditPanel({ api }: { api: AdminApi }) {
  const { state, refresh, paused } = useLiveData(() => api.audit(), POLL.slow)
  // Older pages are held separately from the polled first page, so a refresh
  // cannot discard history the operator deliberately loaded.
  const [older, setOlder] = useState<AuditPage['entries']>([])
  const [loadingMore, setLoadingMore] = useState(false)
  const [exhausted, setExhausted] = useState(false)

  const entries = state.data ? [...state.data.entries, ...older] : []
  // A page that came back exactly full is the only evidence the server has
  // more. Without this the table just stops, and a complete-looking audit
  // trail that is silently truncated is worse than an empty one.
  const pageSize = state.data?.limit ?? 25
  const mayHaveMore = !exhausted && entries.length > 0 && entries.length % pageSize === 0

  const loadMore = async () => {
    const oldest = entries[entries.length - 1]
    if (!oldest || loadingMore) return
    setLoadingMore(true)
    try {
      const next = await api.audit(oldest.id)
      if (next.entries.length === 0) setExhausted(true)
      else setOlder((current) => [...current, ...next.entries])
    } catch {
      setExhausted(true)
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <section className="panel">
      <PanelHeader title="Role audit" state={state} paused={paused} onRefresh={refresh} />
      <StaleBanner state={state} />
      <p className="muted small">
        Append-only. Rows cannot be edited or deleted, including by this console.
      </p>

      {state.data === null ? (
        <p className="muted">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="muted">No role changes recorded.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>When</th><th>Target</th><th>Change</th><th>Actor</th><th>Reason</th></tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="muted">{formatDateTime(entry.createdAt)}</td>
                  <td className="mono small">{entry.targetEmail ?? shortId(entry.targetUserId)}</td>
                  <td>
                    <span className="pill">{entry.previousRole ?? 'none'}</span>
                    {' → '}
                    <span className={`pill role-${entry.newRole}`}>{entry.newRole}</span>
                  </td>
                  <td className="mono small">{entry.actorEmail ?? (entry.actorUserId ? shortId(entry.actorUserId) : 'system')}</td>
                  <td className="reason">{entry.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {mayHaveMore && (
        <p className="muted small" style={{ marginTop: 12 }}>
          Showing the {entries.length} most recent changes.{' '}
          <button type="button" className="ghost" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load older'}
          </button>
        </p>
      )}
      {exhausted && (
        <p className="muted small" style={{ marginTop: 12 }}>
          All {entries.length} recorded changes are shown.
        </p>
      )}
    </section>
  )
}
