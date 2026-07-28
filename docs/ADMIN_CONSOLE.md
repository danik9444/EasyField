# Admin console

A local operator console for managing users and watching the platform. It runs
on your Mac, never on the internet.

```bash
npm run admin:dev
```

Then open http://127.0.0.1:5174.

With no deployment configured it starts in **sample-data mode** and says so on
screen, so the whole console can be used and reviewed before a backend exists.

---

## Should this live in GitHub? Yes.

You said you did not think the dashboard belonged in the repository, and asked
me to decide. It belongs there, and the reasoning matters more than the answer
because it decides where the real risk is.

Three things are easy to conflate:

| | Belongs in Git? |
|---|---|
| **Source code** — the UI, the API, the migration, the tests | **Yes** |
| **Secrets** — the service-role key, provider tokens | **Never** |
| **Public hosting** — a URL anyone can reach | **No, not for this** |

Keeping the source secret would not protect anything. The console's safety comes
from `billing_private.is_active_admin` running on a trusted server, which nobody
bypasses by reading the source. If source secrecy *were* load-bearing, the design
would already be broken.

What you would lose by keeping it out of the repository is concrete:

- **CodeQL** would not scan it. CodeQL has already caught three real filesystem
  bugs in this project.
- **`npm run verify`** would not gate it — no typecheck, no tests, no CI.
- No review, no history, no way to roll back a bad change.
- It would exist on exactly one Mac. One disk failure and it is gone.
- It would drift from the database schema it queries, silently.

So the source is committed, the secrets are not, and the console is never
deployed. `admin/dist` is already ignored, and a test fails the build if a
credential ever reaches the bundle.

---

## How authority works

The console proves two separate things on **every** request:

1. you hold a valid, verified Supabase session, and
2. that same account currently satisfies `is_active_admin`.

```
browser (your session token)
  → easyfield-admin edge function      ← verifies the token, holds the service key
  → public.easyfield_admin_*           ← re-checks is_active_admin in the database
  → billing_private.*                  ← the data
```

Three properties are worth understanding:

**The service-role key never leaves the server.** That key bypasses every
security policy in the database. It lives only in the edge function's
environment. The browser only ever holds your own ordinary user token, and a
test asserts no key can appear in the built bundle.

**The check is repeated in the database, not just in the API.** Each
`easyfield_admin_*` function calls `require_active_admin` before touching data.
So a bug in the edge function is not enough on its own — an attacker would also
need the service-role key. A test enumerates the functions and fails if a new
one is added without the guard.

**Access is re-checked, never cached.** Because the check runs inside each
call's transaction, an admin who is demoted, banned or deleted loses access on
their next request rather than at the end of some session window.

The schema asked for exactly this. From
`202607140001_subscription_billing.sql`:

> A platform_role never bypasses RLS from the client; support/admin tooling must
> authenticate to a trusted server using service_role.

---

## Why it polls instead of using Realtime

Supabase Realtime respects row-level security. Every client policy in this
schema is select-own — `profiles_select_own` is literally `user_id = auth.uid()`
— so an admin subscribing directly would receive **only their own rows**.

Making Realtime work would mean granting broad admin read policies across
thirteen tables. That would replace one audited server path with thirteen silent
ones, and RLS mistakes fail quietly.

So the console polls the trusted server, at a cadence set by how quickly
staleness would mislead:

| Data | Interval |
|---|---|
| Incidents — stuck checkouts, renewals, grants | 4s |
| Overview, users, user detail | 20s |
| Credit ledger, role audit | 60s |

Polling pauses when the window is hidden and refreshes the moment you return.
Every panel shows how old its data is; a failed refresh keeps the last good
values and says so rather than freezing silently.

This is near-real-time, not push. For a single operator it is indistinguishable
in practice. If sub-second updates are ever needed, the right upgrade is a
server-side subscriber relaying *invalidation signals only* — still one gate,
still no new RLS.

---

## What it can do

| Panel | What it shows |
|---|---|
| **Overview** | User counts by role, credits outstanding, subscription and checkout tallies |
| **Users** | Search by email or id, filter by role, see balance, plan and account state |
| **User detail** | Full billing picture, subscriptions, credit ledger, role history |
| **Incidents** | Ambiguous checkouts, open checkouts, unresolved renewals, pending grants |
| **Audit** | Every role change, with actor and reason |

### The only write is the role change

Changing a platform role delegates to `billing_private.set_platform_role`, which
already takes a mutation lock, requires a reason of 3–500 characters, refuses to
demote the final remaining admin, and appends to an immutable audit trail. The
console does not reimplement any of that, because a second copy of a rule can
drift from the first.

The console also refuses to let you remove your own admin access, which is a
different mistake from removing the last admin.

### What it deliberately will not do

- No SQL console, no editable table browser.
- No writes to `credit_ledger` or `platform_role_audit` — both are append-only
  and protected by database triggers.
- No "set balance" control. Credits are money; they move through the existing
  FIFO grant/reserve/capture functions or not at all.
- No marking a checkout paid. A payment that may have taken money is resolved
  with provider evidence, never from this screen.
- No impersonation, no password viewing, no hard deletion.

---

## Connecting it to a deployment

Once Supabase is deployed:

1. Deploy the function: `supabase functions deploy easyfield-admin`
2. Set its secrets — `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`. These are **Function secrets**, never repository
   files.
3. Make yourself the first admin, once, from a trusted database session:
   ```sql
   select billing_private.bootstrap_platform_admin('you@example.com');
   ```
   This works only while no admin exists. Afterwards, roles change through the
   console, with an audit trail.
4. Create `admin/.env.local` (git-ignored):
   ```
   VITE_SUPABASE_URL=https://<project>.supabase.co
   VITE_SUPABASE_ANON_KEY=<the publishable anon key>
   VITE_ADMIN_API_URL=https://<project>.supabase.co/functions/v1/easyfield-admin
   ```
   The anon key is publishable by design. The service-role key has no variable
   here on purpose — there is no path for it to arrive through.

---

## What is proven, and what is not

**Verified now** — `npm run verify`, 755 tests, 0 failures:

- The request contract: routing allowlist, method rejection, page-size bounds,
  UUID validation, reason bounds matching the database, rejection of unknown
  fields, strict bearer parsing.
- Every admin SQL function re-checks the actor; every one is revoked from
  `anon` and `authenticated` and granted only to `service_role`; none writes a
  table directly.
- The edge function authenticates before any database call, takes the actor from
  the verified session rather than the request body, and never reflects database
  detail to the client.
- The whole UI end to end against fixtures, in a real browser: sign-in, every
  panel, a role change appearing in the audit trail, and the last-admin guard
  refusing a demotion.
- The built bundle contains no credential and no source map, and declares a
  policy allowing only the configured origin.
- The migration parses as real PostgreSQL.

**Not proven, and cannot be until Supabase is deployed:**

- That the migration *applies* — parsing is not executing. There is no local
  Postgres or Docker on this machine, so it has not been run against a database.
- Real RLS enforcement, real token verification, real network behaviour.
- Anything requiring a payment provider.

I am not going to call this "100% working" while the backend it talks to does
not exist yet. What is true is that every layer I control is tested, the
remaining gap is the deployment you already know is pending, and connecting it
is configuration rather than more code.
