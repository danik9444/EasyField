-- Defense in depth for the non-exposed billing schema. Direct privileges were
-- already revoked from public clients; RLS now also fails closed if a future
-- schema exposure or grant is added accidentally. Trusted service-role workers
-- continue to bypass RLS. Do not FORCE RLS: owner/security-definer accounting
-- functions are the only supported mutation boundary.

alter table billing_private.plan_catalog enable row level security;
alter table billing_private.saved_payment_methods enable row level security;
alter table billing_private.renewal_attempts enable row level security;
alter table billing_private.payment_event_deliveries enable row level security;
alter table billing_private.checkout_no_payment_reconciliations enable row level security;
alter table billing_private.partner_offer_catalog enable row level security;
alter table billing_private.payment_entitlement_claims enable row level security;
alter table billing_private.partner_purchase_intents enable row level security;

-- Reassert the least-privilege boundary for every private table, including any
-- tables added before this hardening migration. There are deliberately no RLS
-- policies for public, anon, or authenticated.
revoke all on all tables in schema billing_private from public, anon, authenticated;
revoke all on all sequences in schema billing_private from public, anon, authenticated;

