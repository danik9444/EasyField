# Morning payment-adapter research (superseded)

**Status:** superseded on 2026-07-15; must not be deployed or called
**Reviewed against public API:** 2026-07-14, OpenAPI 3.0.3 / API version 2.0.0

> Morning is retained only for accounting/document workflows approved by the
> business's accountant. EasyField will use a different payment provider. The
> code described below is an isolated research scaffold, has no production
> authorization, and must be retired or replaced when that provider is selected.

## Decision

This document records the discarded payment-adapter investigation. It does not
make Morning an EasyField payment provider or subscription database.
The public API currently exposes:

- OAuth 2.0 `client_credentials` access tokens;
- a hosted payment form;
- saved credit-card token search and one-off token charge;
- signed `payment/received` webhook deliveries.

EasyField intentionally exposes no `document/created` billing endpoint. Morning
signs the body but not the topic header, so accepting multiple topics with a
shared secret would make captured bodies reusable across topic endpoints.

The published OpenAPI specification exposes no subscription lifecycle,
recurring-plan, cancellation, entitlement, or documented token-charge
idempotency endpoint. EasyField therefore owns subscription state, renewal
scheduling, entitlements, credit grants, dunning, and the immutable billing
ledger. This is an inference from the complete public path list in the current
official specification and must be rechecked before production launch.

Provider-neutral contracts live in
`supabase/functions/_shared/billing_contracts.ts`. The Morning HTTP, mapping,
signature, and validation utilities live in
`supabase/functions/_shared/morning.ts`.

## Official documentation

- [Morning API documentation](https://developers.morning.co/)
- [Official OpenAPI document (API version 2.0.0)](https://developers.morning.co/docs/openapi.bundled.json)
- [Creating an API key](https://www.greeninvoice.co.il/help-center/generating-api-key/)
- [Configuring Morning webhooks](https://www.greeninvoice.co.il/help-center/creating-webhook/)
- [Payment received webhook example](https://www.greeninvoice.co.il/help-center/webhook-payment-receive/)

The relevant operations in the OpenAPI document are
`obtainAccessToken`, `getPaymentForm`, `searchCreditCardTokens`, and
`chargeCreditCardToken`.

## Production environment variables

Set these as Supabase Function secrets. None belongs in the Electron bundle,
renderer, repository, logs, or webhook payloads.

| Variable | Purpose |
| --- | --- |
| `MORNING_ENVIRONMENT` | Exact enum: `sandbox` or `production` |
| `MORNING_CLIENT_ID` | Morning API client ID |
| `MORNING_CLIENT_SECRET` | Morning API client secret |
| `MORNING_WEBHOOK_SECRET` | Secret configured on the Morning webhook |
| `MORNING_WEBHOOK_ID` | Exact server-owned ID of the single `payment/received` webhook |
| `EASYFIELD_BILLING_CALLBACK_ORIGINS` | Server-owned list of exact HTTPS origins allowed for billing callbacks |
| `MORNING_PAYMENT_SUCCESS_URL` | HTTPS hosted-form success return |
| `MORNING_PAYMENT_FAILURE_URL` | HTTPS hosted-form failure return |
| `MORNING_PAYMENT_NOTIFY_URL` | HTTPS payment notification endpoint |
| `MORNING_DEFAULT_DOCUMENT_TYPE` | Approved Morning paid-document code |
| `MORNING_DEFAULT_VAT_TYPE` | Business-approved VAT behavior |
| `MORNING_DEFAULT_LANGUAGE` | `he` or `en` |
| `MORNING_DEFAULT_PLUGIN_ID` | Optional clearing plugin ID |

Production and sandbox use separate keys. Build and test in Morning's sandbox
first. Callers select only the explicit environment enum; the adapter derives
the exact OAuth and payment URLs from the official specification. It does not
accept endpoint URLs from request data or environment variables, and every
outbound request uses `redirect: "error"`. Success, failure, and notification
URLs must match one of the configured EasyField origins exactly.

## Initial purchase flow

1. Authenticate the EasyField user on the server.
2. Validate the selected plan against a server-owned catalog. Never accept a
   price, currency, VAT code, or credit quantity from the renderer.
3. Persist a pending checkout operation and its price snapshot.
4. Request a Morning hosted payment form. Put only the opaque checkout
   operation ID in `custom`; do not put PII or entitlement claims there.
5. Open the returned HTTPS URL in the system browser.
6. Treat success/failure redirects as user experience only.
7. Activate the purchase only after a valid, deduplicated signed webhook and
   server-side amount/currency/catalog reconciliation.

The hosted-form request defines `custom` as a string, but the official signed
`payment/received` schema exposes an optional free-form object and does not
promise that the hosted-form value is copied into it. The parser tolerates a
bounded operation reference when one is present, but a missing reference stays
`needs_reconciliation`. Automatic checkout completion must remain disabled
until the exact correlation behavior is proven in Morning sandbox; a redirect
or notify callback alone is not payment evidence.

The payment form can produce a document automatically. The public API exposes
token search but no explicit create-token endpoint. Before launch, confirm in
sandbox which payment-plugin/account setting saves a reusable token, the exact
customer association, and the required customer consent language.

Saved-token searches always require a server-resolved Morning customer key.
The adapter sends it as `externalKey` and rejects the complete response if any
returned token has a different or missing `externalKey`. A renderer-supplied
token ID must never be charged without a local customer-to-token binding.

## Renewal scheduler and ledger

The implemented database boundary uses `public.subscriptions`,
`billing_private.renewal_attempts`, `public.credit_accounts`,
`public.credit_grant_lots`, `public.credit_reservations`,
`public.credit_ledger`, and `public.generation_billing_quotes`. Plan access is
enforced from the immutable `billing_private.plan_catalog` snapshot during the
server-side quote/preflight path.

For each due period, the scheduler must:

1. lock the subscription row;
2. create one renewal attempt with a unique `(subscription_id, period_start)`
   key before contacting Morning;
3. mark it `charging` and commit that state;
4. perform exactly one token-charge HTTP request;
5. atomically record the provider document/transaction and grant access or
   credits only on confirmed success;
6. record a definitive 4xx failure for dunning; or
7. record `unknown` for a timeout, connection loss, 5xx/ambiguous status, or
   malformed 2xx response.

### Never automatically retry an ambiguous token charge

Morning documents no idempotency key for `payments/tokens/{id}/charge`. A lost
response can mean either “not charged” or “charged but response was lost.” An
automatic retry can double-charge the customer.

An `unknown` renewal is frozen. Reconcile it using signed webhook records,
Morning documents/payments, the provider transaction ID when available, and
the stable renewal-attempt reference included in the document description or
remarks where legally acceptable. Only an authorized human or a future proven
idempotent reconciliation process can release it for another charge.

The adapter restricts operation IDs to a 1-64 character opaque ASCII alphabet
and always appends `EasyField operation: <operation-id>` to token-charge
remarks. This is a correlation reference, not an idempotency key. It must not
contain an email address, user ID, or other PII.

`notificationUrl` is useful as a wake-up signal, but the payment-operation docs
do not state that this callback carries the configured webhook HMAC headers.
Do not treat an unsigned notify callback as proof of payment.

## Webhook security and delivery handling

Morning signs the exact raw request body with HMAC-SHA256 and sends the
hex-encoded signature in `x-webhook-signature`.

The handler must:

1. read the body as bytes before JSON parsing;
2. verify HMAC with a constant-time comparison;
3. reject every topic other than `payment/received` and require the exact
   configured webhook ID (delivery headers are not signed, so no second billing
   topic may share this secret or endpoint);
4. validate all documented delivery headers and a bounded timestamp window;
5. parse and validate the event only after signature verification;
6. reject a body larger than 256 KiB before HMAC/JSON work;
7. insert `x-webhook-delivery-id`, the SHA-256 of the exact signed body, and the
   signed provider event `id` when present under unique constraints before
   applying effects;
8. compare paid amount and currency with the immutable checkout/renewal price
   snapshot; and
9. return only `200`, `201`, `202`, or `204` quickly, then do durable processing
   asynchronously.

Morning signs the body, not the delivery headers. A timestamp check alone does
not prevent replay of captured raw bytes, because an attacker could replace an
unsigned delivery ID header. Deduplicating the signed-body SHA-256 is always
mandatory; deduplicate the provider event ID as well when the optional field is
present.

The current public webhook schema marks every payment field optional. A valid
signature with missing reconciliation fields is therefore accepted as a
non-grantable `needs_reconciliation` event instead of being rejected. Even a
complete event has `entitlementGrantAllowed: false`: the caller must match it to
the immutable price snapshot before granting anything. The parsed DTO retains
only reconciliation IDs and exact monetary summaries; payer data, card details,
authorization codes, descriptions, and the generic raw payload are discarded.

Never log raw webhook bodies, access tokens, token IDs, authorization codes,
tax IDs, payer data, or secrets. Structured logs should contain only internal
operation ID, delivery ID, topic, outcome, and redacted correlation ID.

## Money and document rules

The provider-neutral API stores money as integer minor units plus an exponent.
For the enabled ILS, USD, EUR, and GBP payment currencies, this adapter requires
exponent `2` and a positive amount no greater than `100,000,000` minor units
(`1,000,000.00`). It converts once at the Morning boundary. Income-row prices
also use `MoneyAmount`; quantities are positive whole units, every row must use
the payment currency, and the row sum must equal the top-level amount exactly.

Document type, VAT type, language, income rows, and invoice wording must come
from a server-owned plan snapshot reviewed by the business's accountant. A
successful payment and its accounting document are related but separate
concerns: webhook idempotency must prevent both duplicate entitlement grants
and duplicate ledger postings.

The accepted launch catalog is USD-only. Adding another currency requires a
new server catalog snapshot and explicit customer prices; it is never derived
from a live exchange rate during checkout.

## Required production decisions

1. Which document type and VAT behavior apply to subscriptions and top-ups?
2. What happens after a refund or chargeback when some of the purchased credit
   lot has already been consumed? Annual plans are already fixed to twelve
   monthly grant windows; subscription credits expire at the next window and
   purchased top-up credits do not expire.
3. What grace period and retry schedule follows a definitive payment failure?
4. Who is permitted to reconcile an `unknown` charge, and what evidence is
   required before retrying?
5. How is saved-card consent presented, revoked, and audited?
6. Does plan cancellation take effect immediately or at period end?
7. What retention policy applies to invoices, webhook evidence, payer data,
   and the internal ledger?
8. Is Morning's reusable-token creation behavior verified for every enabled
    clearing plugin in sandbox and production?
9. Where will OAuth access tokens be cached per isolate, with a refresh margin
    and a single-flight promise so concurrent jobs do not stampede the token
    endpoint? This must never cause an already-dispatched charge to be retried.

## Verification

`supabase/functions/_shared/morning_test.ts` is a dependency-free Deno test
file covering the official HMAC vector, raw-body mutation, minimal/non-grantable
webhook parsing, topic binding, strict time and body limits, exact official
endpoints, callback allowlisting, money/line reconciliation, customer-scoped
token search, full success-shape validation, and the single-attempt/ambiguous-
charge rule. Run it in a Supabase/Deno-enabled environment with:

```sh
deno test supabase/functions/_shared/morning_test.ts
```

The same adapter suite is included in the repository's `npm test` command via a
small `node:test` compatibility wrapper, and `npm run typecheck` performs a
separate strict check of the shared billing TypeScript.

Passing CI or building/installing the Resolve PKG does **not** deploy the cloud
billing boundary. Live billing remains disabled until the database migration
and server functions are deployed, server-only secrets are configured, Morning
webhooks and callback origins are registered, and the renewal/grant workers are
scheduled and verified in the target environment.

Before enabling real renewals, additionally test at the handler/database level:
duplicate and out-of-order webhooks, atomic body-hash/event-ID deduplication,
timeout after provider receipt, worker crashes between charge and ledger commit,
document reconciliation, refunds, and concurrent scheduler workers. OAuth
cache/single-flight behavior also remains an orchestration-level test because
the adapter intentionally does not own process or distributed cache state.
