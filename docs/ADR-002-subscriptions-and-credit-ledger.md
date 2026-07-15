# ADR-002: Subscriptions and credit-ledger domain

**Status:** Accepted domain model; payment-provider selection reopened and live billing disabled
**Date:** 2026-07-15
**Deciders:** Product owner, engineering, finance and legal

## Context

EasyField is currently a local-first Resolve integration. Local media, drafts,
jobs and artifacts remain on the editor's Mac, while paid generation is invoked
through a cloud boundary. Subscriptions introduce money, expiring monthly grants,
non-expiring purchased credits, model entitlements and administrative access.
Those values must not be inferred from renderer state or floating-point numbers.

This ADR defines the domain and trust boundary. Supabase Auth is the identity
authority. Morning remains an accounting/document system only; it is not the
payment processor. The production payment provider, tax presentation,
plan-change behavior and production credentials remain launch gates. This
decision does not authorize live billing by itself.

## Decision

### Plans

| Plan | Monthly | Annual billed upfront | Annual monthly equivalent | Monthly grant | Top-up rate |
|---|---:|---:|---:|---:|---:|
| Starter | $15 | $144 | $12 | 800 credits | $0.020/credit |
| Creator | $30 | $300 | $25 | 2,000 credits | $0.015/credit |
| Pro | $60 | $588 | $49 | 5,000 credits | $0.012/credit |
| Studio | $129 | $1,188 | $99 | 12,000 credits | $0.010/credit |

- The minimum top-up purchase is $10.
- Auto-reload is optional and disabled unless the account explicitly enables a
  valid threshold and top-up amount.
- Starter blocks only the exact regular **Seedance 2** model identity. Seedance 2
  Fast and Seedance 2 Mini remain entitled. All other model entitlements are
  unchanged by this foundation.
- The initial platform administrator is established once through the trusted
  database bootstrap using the owner email supplied at deployment. The address
  is not bundled into the app, and an email check in a client is never
  authorization.

### Integer authority

One USD is `1,000,000` money micros and one credit is `1,000,000` credit micros.
Prices, balances, grants, reservations and ledger movements are persisted as safe
integers. Decimal USD or credit values are display-only. Plan-rate multiplication
uses integer arithmetic; a card charge is then rounded upward to the nearest USD
cent. The $10 top-up minimum is checked against the nominal plan-rate amount
before that payment-rail rounding.

### Credit lots

Subscription credits and purchased credits are separate immutable-origin lots:

- A subscription grant has `availableAt` and `expiresAt`. It expires at the next
  monthly grant boundary.
- Monthly subscribers receive one grant for each monthly billing period.
- Annual subscribers are billed upfront but receive twelve separate monthly grant
  windows. Each grant expires at the following monthly boundary; the annual
  allocation is never granted as one long-lived balance.
- Purchased top-up credits have `expiresAt = null` and do not expire.
- A future ledger should consume the soonest-expiring active subscription lot
  first, then non-expiring purchased lots. Every debit requires an idempotency key
  and an append-only audit record.

### Trust boundary

The cloud control plane is authoritative for identity, subscription status,
entitlements, top-up confirmation and credit-ledger mutations. Electron Main may
cache a non-secret account snapshot for UI and offline messaging, but the renderer
must not authorize paid work. Payment webhooks and administrator actions are
verified server-side. The existing local Artifact Store, Library and Resolve jobs
remain the media data plane and do not move to cloud storage by this decision.

### Identity and desktop session

- Supabase Auth provides verified email/password accounts plus Google and Apple.
- Social sign-in opens in the system browser. The desktop plugin uses a
  short-lived, PKCE-bound authorization flow; it never accepts an identity from
  an unverified callback parameter.
- Refresh credentials are owned by Electron Main and protected by macOS secure
  storage. The renderer receives only the account/session DTO required for UI.
- Platform roles come from the database. The first admin is bootstrapped once
  from a trusted server/SQL session; a client email comparison has no authority.
- A server-asserted admin keeps the existing operator path: generation quotes
  are marked as an admin bypass and do not debit the customer credit ledger.
  The admin-only endpoint may return the live upstream balance and raw cost;
  customer and support sessions never receive those fields.

### Payment adapter

- No production payment adapter is selected. Morning must not create EasyField
  checkouts, charge saved cards or receive payment webhooks.
- Morning may be used downstream for the Israeli accounting documents approved
  by the business's accountant. It never grants a subscription or credits.
- A Merchant of Record is preferred for global tax registration, calculation,
  filing and remittance. The selected provider must first approve EasyField's
  avatar, human-face, voice and non-transferable usage-credit functionality in
  writing.
- If a direct PSP is selected instead, EasyField owns renewals, dunning, global
  sales-tax compliance and document orchestration in addition to entitlements,
  grants, reconciliation and idempotency records.

### Deployment boundary

The repository's CI, desktop build and Resolve PKG packaging validate and ship
only the local application/plugin artifacts. They do not apply the Supabase
migration, deploy server functions, install secrets, register payment webhooks,
or schedule renewal and monthly-grant workers. The legacy Morning payment
adapter scaffold is not a deployable billing path. Live authentication and
billing must remain disabled until the selected provider's cloud deployment is
completed and verified in the target environment.

## Plan-change defaults — proposed, not accepted

The following defaults are included to make open questions explicit. They must
not drive production billing until this ADR is revised to **Accepted**:

- Upgrade: immediate with payment-provider proration.
- Downgrade: effective at the next renewal.
- Monthly to annual: immediate with provider proration.
- Annual to monthly: effective at the next renewal.
- Existing subscription grant lots retain their original expiry.
- Purchased credits survive plan changes and remain non-expiring.

Still undecided: whether an immediate upgrade receives a prorated grant delta,
how refunds reverse purchased credits already consumed, delinquency grace, and
what happens to unspent subscription grants on cancellation.

## Options considered

### A. Integer, lot-based server ledger

| Dimension | Assessment |
|---|---|
| Correctness | High; expiry and purchase origin remain explicit |
| Complexity | Medium |
| Auditability | High |
| Offline behavior | Local work remains available; paid runs require server preflight |

**Pros:** deterministic billing, idempotent debits, exact expiry, safe annual
grant cadence.
**Cons:** requires a backend ledger, reservations and webhook reconciliation.

### B. One mutable floating-point balance in the desktop app

| Dimension | Assessment |
|---|---|
| Correctness | Low; rounding and expiry provenance are lost |
| Complexity | Low initially, high during reconciliation |
| Auditability | Low |
| Offline behavior | Appears convenient but cannot safely authorize paid work |

**Pros:** minimal initial UI work.
**Cons:** forgeable, cannot distinguish expiring from purchased credits, unsafe
for refunds, retries, concurrent devices or administrator adjustments.

## Consequences

- Plan prices and credit grants can be tested without a payment-provider SDK.
- Annual billing and monthly credit availability are independent concepts.
- Purchased credits cannot be silently expired or merged into subscription lots.
- The backend must enforce entitlements even when the renderer displays cached
  account information.
- A successful PKG build or CI run is not evidence that the cloud billing
  control plane has been deployed.
- Plan changes remain blocked from production behavior until the unresolved
  policy questions are accepted.
- The 2026-07-15 forward price revision is intentionally pre-launch and
  fail-closed: it will not rewrite active subscriptions, open payments or
  pending grants. Once live billing exists, a later repricing requires an
  append-only versioned catalog plus an explicit grandfathering/migration
  policy rather than mutating paid-period snapshots.

## Action items

1. [ ] Select and obtain written product approval from the payment provider;
   document webhook ownership.
2. [x] Define append-only ledger, reservation, settlement and idempotency schemas.
3. [ ] Decide account isolation for the local Library and Artifact Store.
4. [ ] Resolve upgrade grant deltas, refunds, delinquency and cancellation policy.
5. [ ] Add Main-owned account/session IPC that never exposes refresh tokens.
6. [ ] Require the deployed server entitlement and balance preflight for every paid job.
