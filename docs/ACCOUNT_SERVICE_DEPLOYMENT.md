# EasyField account service deployment

The desktop build now has a server-owned account boundary. Regular customers
sign in with an EasyField account; provider credentials, service-role keys,
checkout credentials, checkout references, and payment evidence stay outside
the renderer and outside the packaged app.

## What is implemented

- `easyfield-account` authenticates every request against Supabase Auth and
  exposes `/checkout`, `/checkout-status`, `/auto-reload`,
  `/service-capabilities`, `/direct-access`, and `/privileged-snapshot`.
- Regular customers authenticate with their EasyField account. They never
  enter, receive, or inspect a cloud-provider credential, provider balance,
  provider purchase link, or raw provider price. The renderer receives only a
  sanitized EasyField account and credit snapshot.
- Direct cloud access is a separate server-issued capability. Only a verified
  administrator or an active lifetime Partner may use it, and its credential
  remains encrypted and account-scoped in Electron Main. Partner is not an
  administrator role and includes no EasyField credits.
- Checkout prices and credit quantities are read from the private database
  catalog. Client-supplied prices are not accepted.
- The hosted-checkout adapter is environment-driven, uses an idempotency key,
  validates the returned checkout URL against an operator allowlist, and
  rejects a hosted session unless it echoes the exact operation, purchase
  kind, offer key, variant, amount, and currency requested by the server.
  It returns no provider name or secret to the desktop client.
- The desktop persists one encrypted checkout operation per EasyField account
  before making the request. Network retries, app restarts, and sign-out reuse
  that request ID for the same account. A different account cannot resume it.
  The desktop never decides payment completion from its local clock, a checkout
  URL expiry, a changed credit balance, or a changed entitlement.
- `/checkout-status` resolves the caller-owned request ID through a
  service-role RPC and returns only normalized states: `prepared`, `open`,
  `awaiting-reconciliation`, `completed`, or `closed-unpaid`. Only the signed
  webhook and database reconciliation may create a terminal payment result.
- `/service-capabilities` is the authoritative availability response used by
  the desktop. It independently reports customer generation, customer
  checkout, Partner checkout, and billing-portal availability; absent or
  malformed capability data fails closed.
- `easyfield-billing-webhook` verifies HMAC-SHA256 over a canonical Unix-seconds
  timestamp, a `.` separator, and the exact raw request bytes. The signed
  timestamp must be no more than five minutes old or 30 seconds in the future.
  The function then validates a strict provider-neutral event and invokes one
  database transaction that records and claims the event, reconciles the
  immutable catalog amount, completes the purchase, materializes the
  entitlement, and grants or schedules credits exactly once.
- If materialization cannot be proven, its database subtransaction rolls back
  every entitlement and ledger write while retaining the signed event as
  `failed`; the webhook returns `503`, so the identical delivery can be retried
  without losing evidence or double-granting.
- Missing configuration returns `503`; it never returns a checkout success,
  creates credits, or enables generation.

## Required database deployment

Apply the migrations in filename order, including:

```text
202607150004_account_edge_api.sql
202607150005_atomic_payment_reconciliation.sql
202607150006_checkout_status_recovery.sql
20260715154941_creator_monthly_price_24.sql
20260715170000_private_billing_rls_hardening.sql
20260715175329_generation_gateway_control_plane.sql
202607290001_generation_settlement_lock_order.sql
```

The new public RPC names are callable only by `service_role`. Authenticated
desktop users remain read-only under RLS.

`202607150006_checkout_status_recovery.sql` widens the one-payable-checkout
boundary to retain ambiguous states until merchant reconciliation, rejects a
second subscription checkout while an existing subscription must be managed in
the billing portal, and adds the narrow account-owned checkout-status RPC. Do
not replace that status with client-side balance or timeout heuristics.

## Authenticated account endpoints

All paths below require a valid EasyField bearer session. The Edge Function
also verifies that every account-scoped result belongs to the authenticated
Supabase user.

| Path | Method | Purpose |
| --- | --- | --- |
| `/service-capabilities` | `GET` | Return server-authoritative feature availability. |
| `/checkout` | `POST` | Prepare or resume an idempotent hosted checkout. |
| `/checkout-status` | `POST` | Resolve the stored checkout request ID without exposing payment evidence. |
| `/auto-reload` | `POST` | Change the server-owned auto-reload preference. |
| `/direct-access` | `GET` | Return only whether this account has verified direct access. |
| `/privileged-snapshot` | `GET` | Return the restricted Admin/Partner snapshot after server authorization. |

`/gateway/provider…` is authenticated but deliberately returns structured
`503` while the real customer generation gateway is unavailable. It must not
be replaced by a desktop-side provider call for regular customers.

## Edge Function secrets

Set these only as Supabase Function secrets. Never put them in
`plugin/account-config.json`, a prompt, a source file, a release artifact, or
version control.

```text
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY

EASYFIELD_BILLING_PROVIDER_ID
EASYFIELD_CHECKOUT_API_URL
EASYFIELD_CHECKOUT_API_TOKEN
EASYFIELD_CHECKOUT_HOSTS
EASYFIELD_CHECKOUT_VARIANTS_JSON
EASYFIELD_CHECKOUT_SUCCESS_URL
EASYFIELD_CHECKOUT_CANCEL_URL
EASYFIELD_BILLING_WEBHOOK_URL

EASYFIELD_WEBHOOK_SECRET
EASYFIELD_WEBHOOK_SIGNATURE_HEADER       # optional, default x-signature
EASYFIELD_WEBHOOK_DELIVERY_HEADER        # optional, default x-delivery-id
EASYFIELD_WEBHOOK_TIMESTAMP_HEADER       # optional, default x-timestamp

EASYFIELD_PRIVILEGED_BALANCE_API_URL
EASYFIELD_PRIVILEGED_BALANCE_API_TOKEN
```

The timestamp header must contain canonical base-10 Unix seconds. The
signature is the hexadecimal HMAC-SHA256 of
`<timestamp>.<exact raw request bytes>`.

`EASYFIELD_CHECKOUT_VARIANTS_JSON` is a JSON object. Supported keys are:

```text
subscription:<starter|creator|pro|studio>:<monthly|annual>
top-up:<starter|creator|pro|studio>
partner
billing-portal
```

Example values are opaque merchant-adapter variant identifiers. Do not put
prices in this JSON; the database catalog remains authoritative.

The adapter at `EASYFIELD_CHECKOUT_API_URL` must accept:

```json
{
  "operationId": "uuid",
  "variantId": "opaque-id",
  "offerKey": "subscription:creator:monthly",
  "purchaseKind": "subscription",
  "amount": { "currency": "USD", "minorUnits": 3000, "exponent": 2 },
  "customer": { "accountId": "uuid", "email": "customer@example.com" },
  "successUrl": "https://…",
  "cancelUrl": "https://…",
  "notificationUrl": "https://…",
  "metadata": {
    "operationId": "uuid",
    "purchaseKind": "subscription",
    "offerKey": "subscription:creator:monthly",
    "variantId": "opaque-id"
  }
}
```

It must return an idempotent session that echoes the exact identity and amount
from the request. A mismatch fails closed before any URL reaches the desktop:

```json
{
  "operationId": "uuid",
  "variantId": "opaque-id",
  "offerKey": "subscription:creator:monthly",
  "purchaseKind": "subscription",
  "amount": { "currency": "USD", "minorUnits": 3000, "exponent": 2 },
  "checkoutUrl": "https://allowlisted-checkout-host/…",
  "checkoutReference": "opaque-reference",
  "expiresAt": "2026-07-15T12:00:00.000Z"
}
```

For `billing-portal`, `amount` must be JSON `null`; for every purchase it must
be the exact server-catalog amount. The account Function returns only the
allowlisted URL plus `intentId`, the original `requestId`, `checkoutKind`, and
`checkoutExpiresAt`. The Main process verifies the request identity again
before opening the system browser.

The signed webhook body contract is:

```json
{
  "type": "payment.completed",
  "paymentReference": "opaque-payment-reference",
  "operationReference": "checkout-intent-uuid",
  "amount": { "currency": "USD", "minorUnits": 3000, "exponent": 2 },
  "subscriptionReference": "opaque-subscription-reference-or-null",
  "periodStart": "2026-07-15T00:00:00.000Z",
  "periodEnd": "2026-08-15T00:00:00.000Z"
}
```

The signature is lower/upper-case hex HMAC-SHA256 of the exact body. The
delivery header must be an opaque, stable, unique delivery ID. Deploy the
webhook function without Supabase JWT verification because HMAC verification
is its authentication boundary; keep JWT verification enabled for
`easyfield-account`.

## Desktop public configuration

After deploying, create the untracked production equivalent of
`plugin/account-config.example.json` with the public project URL, public anon
key, the `easyfield-account` Function URL, `oauthProviders` containing both
`google` and `apple`, and the hosted checkout host allowlist. The release
validator rejects a build that omits either requested sign-in route. No
service-role or merchant secret belongs in that file.

For GitHub releases, validate that file locally and store only its one-line
base64 representation in the protected release-environment secret
`EASYFIELD_ACCOUNT_CONFIG_BASE64`. The Release workflow materializes the file
with restrictive permissions before generating `plugin/update-manifest.json`,
then removes it during cleanup. Pull-request CI deliberately has no access to
this value. It first runs the `--ci-structure-test` fail-closed check, then
exercises only clearly named unsigned/non-production structure artifacts that
contain no `account-config.json`, as described in `docs/RELEASING.md`.

Password recovery is end-to-end inside the desktop boundary: Electron Main
creates the PKCE request, owns the temporary recovery session, consumes the
trusted `http://127.0.0.1:18832/auth/recovery` callback, and exposes only a
one-time attempt ID plus terminal state to the renderer. The packaged Resolve
build must complete an email-link test; sending the email alone is not
sufficient.

### Redirect allowlist — must be the wildcard form

Both loopback callbacks carry a per-attempt nonce that binds the browser's
return to the Main-process attempt that started it
(`plugin/account-service.cjs:1112`, `:1351`), so the URL Supabase receives is:

```
http://127.0.0.1:18832/auth/recovery?attempt=<random per attempt>
http://127.0.0.1:18832/auth/callback?attempt=<random per attempt>
http://127.0.0.1:18832/auth/confirm?attempt=<random per attempt>
```

An exact-match allowlist entry can therefore **never** match. GoTrue falls back
to the Site URL instead: the customer authenticates with Google or Apple
successfully, lands on the website, and the plugin sits on "Finish signing in
with Google in your browser" until it times out. Password recovery fails the
same way, and neither produces an error anyone can see.

Add these to **Authentication → URL Configuration → Redirect URLs**, using the
`**` wildcard so the nonce is covered:

```
http://127.0.0.1:18832/auth/callback**
http://127.0.0.1:18832/auth/recovery**
http://127.0.0.1:18832/auth/confirm**
```

Verify by completing one real Google sign-in and one real password reset end to
end in the packaged build. A redirect that lands anywhere other than the plugin
means the allowlist is still exact-match.

## Deliberate production blockers

Customer generation remains explicitly unavailable rather than unsafe:

`/gateway/provider…` authenticates the account and returns structured `503`.
It needs a server-side model-price resolver and a durable provider-task binding
around the existing `create_generation_quote`, `reserve_credits`,
`capture_credits`, and `release_credits` functions. Forwarding before those
contracts exist could create unbilled paid work.

This repository is therefore **not production-ready for paid accounts**. Before
shipping, all of the following external work must be complete and verified:

- Deploy a real server-side generation gateway with an authoritative model and
  price resolver, atomic quote/reservation/capture/release, durable provider-task
  binding, crash recovery, replay protection, cancellation and partial-failure
  tests. Regular customers must never be routed around it.
- Deploy Supabase Auth, every migration through
  `20260715170000_private_billing_rls_hardening.sql`, both Edge Functions, scheduled
  grant/expiry workers, RLS policies, and the production public account config.
- Deploy and sandbox-test the merchant checkout adapter, allowlisted checkout
  hosts, signed raw-body webhook delivery, retry behavior, no-payment
  reconciliation, renewals, refunds, disputes and chargebacks.
- Complete Partner no-payment, refund and chargeback handling so a reversal
  atomically removes the lifetime direct-access entitlement. Partner checkout
  remains independently unavailable until this is proven.
- Allowlist and test the existing Main-owned password-recovery callback, plus
  email/password, Google, and Apple sign-in from the packaged Resolve host.
- Complete tax, invoice, privacy, support and operational monitoring decisions,
  then run end-to-end paid sandbox tests from checkout through local artifact
  persistence and credit settlement.

Subscription and top-up checkout are server-blocked while the generation
gateway flag is off. Partner checkout is blocked while reversal handling is
off. `scripts/release-account-config.mjs` and the production package builders
reject either condition. Missing merchant or Supabase configuration also fails
closed; there is no local/demo payment success fallback.
