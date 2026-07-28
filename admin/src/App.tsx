import { useMemo, useState } from 'react'
import { AdminApiError, createApi, isFixtureMode, readConfig, signIn, type Session } from './api'
import { AuditPanel, IncidentsPanel, OverviewPanel, UserDetailPanel, UsersPanel } from './panels'

type View =
  | { name: 'overview' }
  | { name: 'users' }
  | { name: 'user'; userId: string }
  | { name: 'incidents' }
  | { name: 'audit' }

const TABS = [
  { name: 'overview', label: 'Overview' },
  { name: 'users', label: 'Users' },
  { name: 'incidents', label: 'Incidents' },
  { name: 'audit', label: 'Audit' },
] as const

export function App() {
  const config = useMemo(readConfig, [])
  const fixtures = isFixtureMode(config)
  const [session, setSession] = useState<Session | null>(null)
  const [view, setView] = useState<View>({ name: 'overview' })

  // Memoised because a fresh client on every render would hand each panel a new
  // object identity, and in fixture mode would also discard the in-memory
  // mutations that let the write paths be exercised without a backend.
  const api = useMemo(
    () => (session === null ? null : createApi(config, session)),
    [config, session],
  )

  if (session === null || api === null) {
    return <SignIn config={config} fixtures={fixtures} onSignedIn={setSession} />
  }

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <span>EasyField Admin</span>
        </div>
        <nav>
          {TABS.map((tab) => (
            <button
              key={tab.name}
              type="button"
              className={view.name === tab.name || (tab.name === 'users' && view.name === 'user') ? 'is-active' : ''}
              onClick={() => setView({ name: tab.name } as View)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <div className="who">
          <span className="mono small">{session.email}</span>
          <button type="button" className="ghost" onClick={() => setSession(null)}>Sign out</button>
        </div>
      </header>

      {fixtures && (
        <div className="banner is-warn global" role="status">
          <strong>Sample data.</strong> No admin API is configured, so nothing on screen reflects a
          real account. Set <code>VITE_ADMIN_API_URL</code>, <code>VITE_SUPABASE_URL</code> and{' '}
          <code>VITE_SUPABASE_ANON_KEY</code> to connect a deployment.
        </div>
      )}

      <main>
        {view.name === 'overview' && <OverviewPanel api={api} />}
        {view.name === 'users' && (
          <UsersPanel api={api} onOpenUser={(userId) => setView({ name: 'user', userId })} />
        )}
        {view.name === 'user' && (
          <UserDetailPanel
            api={api}
            userId={view.userId}
            actorEmail={session.email}
            onBack={() => setView({ name: 'users' })}
          />
        )}
        {view.name === 'incidents' && <IncidentsPanel api={api} />}
        {view.name === 'audit' && <AuditPanel api={api} />}
      </main>
    </div>
  )
}

function SignIn({
  config,
  fixtures,
  onSignedIn,
}: {
  config: ReturnType<typeof readConfig>
  fixtures: boolean
  onSignedIn: (session: Session) => void
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      onSignedIn(await signIn(config, email.trim(), password))
    } catch (caught) {
      setError(caught instanceof AdminApiError ? caught.message : 'Sign-in failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="signin">
      <form onSubmit={submit}>
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <span>EasyField Admin</span>
        </div>

        {fixtures ? (
          <p className="muted small">
            No admin API is configured, so this console will run on sample data. Any email works.
          </p>
        ) : (
          <p className="muted small">
            Sign in with your EasyField account. Administration is granted by platform role, not by
            reaching this page.
          </p>
        )}

        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required={!fixtures}
          />
        </label>

        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        {error && <div className="banner is-error" role="alert">{error}</div>}

        <p className="muted small footnote">
          The session is held in memory only and is gone when this tab closes, so a token cannot be
          recovered from browser storage later. Reloading signs you out.
        </p>
      </form>
    </div>
  )
}
