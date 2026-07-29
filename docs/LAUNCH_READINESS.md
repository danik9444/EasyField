# Launch readiness

What is true on 2026-07-29, after a parallel audit of the deployed system by
ten Codex agents and six independent agents of my own, with every finding put
through two skeptics whose job was to refute it.

The short version: **"only connect a payment provider" is not yet accurate.**
It is closer than it was, and the remaining work is smaller and better
understood, but several things would break for a real paying customer on day
one. They are listed here without softening.

---

## Live and verified

| | |
|---|---|
| Supabase project | `xtnaqwvayenfcqzqelmh`, eu-central-1, ACTIVE |
| Migrations | 16 applied and recorded |
| Edge functions | `easyfield-account`, `easyfield-admin` deployed |
| Scheduler | `pg_cron` installed; 4 jobs firing, run history recorded |
| Admin | dannykhanin@gmail.com |
| Catalog | starter $15/$144 · creator $24/$240 · pro $60/$588 · studio $129/$1188 |
| Test gate | `npm run verify` — 765 tests, 0 failures |

**Security came back clean.** Two independent attack-surface audits found no
path to another customer's rows, no privilege escalation, no client mutation,
and no provider-detail leakage. `billing_private` has zero grants to
`anon`/`authenticated`; `public` has zero client INSERT/UPDATE/DELETE grants.
A real verified non-admin session receives 403 from every admin route.

---

## Fixed in this pass

- **Nothing ran the maintenance jobs.** Annual subscribers would have received
  1 of 12 instalments; unsettled reservations would have held customer balance
  forever. `pg_cron` now runs all three, with a run history so a dead scheduler
  shows in the console instead of looking healthy.
- **The built console could not reach its own backend.** Its CSP was compiled
  from a different env directory than `import.meta.env`, so the shipped
  artifact knew the Supabase URL while its own policy forbade calling it. Only
  the dev server worked. A test now fails if any origin in the bundle is
  missing from `connect-src`.
- **An ended session left the screen looking fine.** A 401/403 now signs the
  operator out instead of being polled through.
- **User search treated `_` as a wildcard**, so an exact address search could
  silently return several accounts — immediately before a role change.

---

## Genuinely blocked on the payment provider

These are correct designs waiting for their input. Doing them now would mean
inventing evidence the system deliberately refuses to fabricate.

1. **`easyfield-billing-webhook` is not deployed.** It is the only thing that
   can turn a payment into an entitlement. It needs
   `EASYFIELD_WEBHOOK_SECRET` and `EASYFIELD_BILLING_PROVIDER_ID`, and each
   provider signs differently. Deploy it *with* the provider, not before.
2. **An abandoned checkout cannot currently be reopened.**
   `mayStartNewCheckout` is true only for `closed-unpaid`, and the only route
   to that state is `reconcile_checkout_without_payment`, which requires signed
   provider evidence that no provider yet supplies. The recovery path exists
   and is right; it has nothing to consume. Until then, one abandoned checkout
   blocks that customer from subscribing again.
3. **`CUSTOMER_GENERATION_GATEWAY_READY` / `PARTNER_REVERSAL_HANDLING_READY`**
   remain `false` on purpose. Flipping the first sells plans while generation
   still returns 503; flipping the second sells lifetime access with no
   refund-driven revocation path.

---

## Not blocked on the provider — closed

All six are done except one, which is not mine to do.

1. **Recurring renewals now have a caller.** `sweep_due_renewals` runs every
   five minutes with a one-day lead and enqueues every chargeable renewal. The
   charge still needs a provider; the decision and the record no longer wait
   for one.
2. **The release gate no longer blocks a valid configuration.** It demanded
   both OAuth providers and a nonempty checkout host list, so an email-only
   build with checkout deliberately closed could not be signed at all — the
   only way to produce one was to name a host the product does not use, which
   passes the gate and sends customers somewhere real that is not the
   merchant. An empty allowlist is the fail-closed state and is accepted;
   everything present is validated as strictly as before. The gate now stops
   only on the deliberate gateway blocker.
3. **The redirect guidance is corrected, and email confirmation now returns
   the customer to the app.** The docs had said the loopback callbacks needed
   wildcard allowlist entries. Tested against the deployed project, they do
   not: a foreign `redirect_to` is refused and falls back to `site_url`, while
   `http://127.0.0.1:18832/auth/confirm` is honoured. Separately, sign-up and
   resend now send a `redirect_to` at all — they did not before, so confirming
   an email left the customer on a web page to sign in again by hand.
4. **Auto-reload is visible.** Accounts past their threshold are listed.
   Charging needs a provider; the trigger no longer passes unnoticed.
5. **Alerting exists.** `operational_alerts()` answers "what is wrong right
   now" in one call and the console leads with it — a stale scheduler, a
   renewal stuck mid-charge for an hour, a day-old open checkout.
6. **Leaked-password protection is still off, and I cannot turn it on.** There
   is no `auth.config` table and no management token on this machine; the
   setting lives in GoTrue’s environment. Dashboard → Authentication →
   Policies. One toggle.

Also closed, found by the same audit:

- The console silently truncated every list at the page size, including the
  role audit it labels "append-only". The cursor is now honoured end to end,
  and a full page offers the next one rather than just stopping.
- User detail fetched partner entitlement, auto-reload, grant lots and role
  history and rendered none of them. All four now appear.

---

## Suggested order

1. Decide whether to move the Supabase project to Pro. Leaked-password
   protection is **not a toggle we declined to flip** — it is gated to Pro and
   above, and this project is on Free. Until then the compensating control is a
   12-character minimum, enforced by the project and mirrored by the plugin
   (`MIN_PASSWORD_LENGTH`). That is the weaker control: length alone does not
   catch a long password that is already in a breach corpus.
2. Fill `checkoutHosts` in the release config once the merchant is known. The
   plugin becomes shippable.
3. Choose the provider. Deploy `easyfield-billing-webhook` with its secrets.
4. Build the checkout-expiry reconciliation on top of the provider's evidence.
5. Only then flip the two READY flags.

## Done since this list was written

- **`website/` is deployed and the domain is live.** `https://easyfield.ai`
  serves from Vercel on a Let's Encrypt certificate; `www` 308-redirects to the
  apex so there is one canonical origin.
- **`site_url` points at it.** Confirmed against GoTrue, not the Dashboard: a
  foreign `redirect_to` now falls back to `https://easyfield.ai` and is still
  refused. Auth links no longer land on a dead port.
