# EasyField billing migration

`202607140001_subscription_billing.sql` is the server-side accounting boundary for subscriptions and EasyField credits.

Key invariants:

- One displayed EasyField credit is `1,000,000` integer microcredits. Currency uses integer micros too; floating-point money is never stored.
- Authenticated clients have read-only access to their own RLS-scoped records and `public.my_billing_snapshot()`. They receive no table mutation privileges.
- Raw provider cost is stored only in `generation_billing_quotes.provider_cost_currency_micros`; that column is not granted to authenticated clients. Admin tooling must read it through a trusted service-role backend after authorizing the admin account.
- A trusted backend creates a quote. Customer quotes call `billing_private.reserve_credits(...)` before provider submission, then `capture_credits(...)` or `release_credits(...)`. Server-confirmed administrator-bypass quotes deliberately skip reservation and ledger debit. Each customer-credit operation requires an idempotency key.
- `credit_ledger` and `platform_role_audit` are append-only. Corrections are compensating entries.
- Credit lots are consumed earliest-expiry-first. Expired lots are never restored when a late reservation is released.
- Payment webhook delivery is deduplicated with `billing_private.record_payment_event(...)` by signed provider event ID, exact raw-body SHA-256 and transport delivery ID. Same-ID/different-body replays are rejected; an absent provider event ID is replaced with a deterministic body-hash identity. Only one immutable canonical delivery row is retained for each signed event, so harmless transport retries cannot grow the evidence table without bound.
- `record_payment_event(...)` persists only the provider-neutral, PII-redacted reconciliation DTO. Database allowlists reject unknown top-level, transaction and amount keys, and every stored DTO keeps `entitlementGrantAllowed = false`; reconciliation must still complete before a checkout or renewal may fund credits.
- A checkout cannot become `completed` until it uniquely references a processed `payment/received` event whose provider, event/payment reference, checkout operation reference, currency and exact minor-unit amount all reconcile. That evidence and any paid subscription period become immutable at completion.
- Paid `subscription`, `credit_pack` and `auto_reload` lots have a unique foreign key to exactly one completed checkout or successful renewal. Their idempotency key is derived from that immutable source rather than accepted from a client. Annual monthly lots remain linked one-to-one through their grant schedule.
- Annual subscriptions use `schedule_annual_plan_grants(...)`; the subscription and every immutable schedule row retain the one paid checkout/renewal source for the exact annual period. Every monthly lot expires at the following monthly boundary, and a trusted scheduled worker calls `grant_due_annual_plan_credits(...)`. Idempotent schedule retries resolve the persisted paid period even after a later renewal advances the subscription row.
- Administrator powers require both the server-owned `admin` profile role and a current Supabase Auth user that is confirmed, not deleted and not banned. The same predicate gates role mutations and generation-credit bypass.
- The safe account snapshot classifies active lot balances by `source_type` as subscription, purchased and other credits; expiry alone never determines the commercial category.
- A trusted scheduled worker should also call `expire_credit_lots(...)` and `expire_credit_reservations(...)` regularly. Never run provider work after a failed reservation.

## Safe first-admin bootstrap

No email is hard-coded and no client may assert an admin role. First create/sign in the user through Supabase Auth, then run this once from a trusted migration/SQL-console session:

```sql
select billing_private.bootstrap_platform_admin('owner@example.com');
```

The function normalizes the email with `lower(btrim(...))`, requires exactly one matching `auth.users` row whose email is confirmed and whose account is neither deleted nor currently banned, changes the server-owned profile role, and appends an audit record. Subsequent role changes should use `billing_private.set_platform_role(...)` from the trusted backend with an authenticated admin actor ID and a reason.

## Backend transaction order

1. Authenticate the EasyField account and compute customer price plus private provider cost on the server.
2. Create an immutable/idempotent quote with `create_generation_quote(...)`.
3. For a customer quote, reserve its full customer charge with `reserve_credits(...)`. For a server-confirmed administrator-bypass quote, verify `admin_bypass = true` and skip the credit ledger entirely.
4. Only after the customer reservation commits (or the administrator bypass is verified), submit the provider task and durably bind its task ID to the application job.
5. For customer quotes, capture according to the product's provider-acceptance/success policy. Release only after a definitive rejection/cancellation. An ambiguous submission remains reserved until reconciliation. Administrator-bypass jobs have no credit reservation to capture or release.
6. Return refreshed `my_billing_snapshot()` data to the client; client-side counters are display caches, never billing authority.
