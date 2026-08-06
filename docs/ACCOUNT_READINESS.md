# Account, pricing and credits — readiness assessment

> ## SUPERSEDED — and wrong in its headline. See `LAUNCH_READINESS.md`.
>
> Kept for its reasoning, which is still good. Do not use it to decide anything.
> Verified against the deployed system on 2026-08-06:
>
> - **Section 1 is false.** It opens by asserting the Supabase project does not
>   resolve (`NXDOMAIN`, `HTTP 000`). The project is `ACTIVE_HEALTHY` and has
>   been continuously; `nslookup` resolves and SQL runs. Acting on this section
>   would send you to create a second project while the free-tier active-project
>   ceiling already constrains you.
> - **The validator error it quotes does not exist.** There is no
>   `"oauthProviders must enable both google and apple"` string anywhere in the
>   repository. The validator accepts an empty array deliberately and explains
>   why in its own comments. The same applies to `checkoutHosts`: an empty list
>   passes, and that is the fail-closed state.
> - **Item 6 (Creator annual) is resolved** — $240 on both the client constant
>   and the server catalog, now also pinned on the website by
>   `tests/website-pricing-parity.test.ts`.
> - **Item 5 (pricing behind the sign-in wall) is still true** and still open.
> - **Item 1 (deploy the backend) is done.** 22 migrations, both edge functions
>   deployed, 7 cron jobs active.
>
> What it got right and is worth reading: the observation that a green test
> suite proves nothing about infrastructure, since no test reaches the account
> service over the network. That is exactly how a non-existent backend went
> unnoticed, and it is why `LAUNCH_READINESS.md` now cites only figures checked
> against the live system.

Assessed at `cbb6c2e` on `main`, version 1.3.0.

This document answers three questions raised while running the installed plugin:
sign-up did not work, no pricing was visible, and there was no way to buy
credits. It also separates the work that genuinely waits on the payment-provider
decision from the work that does not.

It combines two independent analyses — one produced without access to the other —
and records where they disagreed, because each found something the other missed.

---

## 1. The headline: three symptoms, one root cause

The configured Supabase project does not exist.

```
$ nslookup xtnaqwvayenfcqzqelmh.supabase.co
** server can't find xtnaqwvayenfcqzqelmh.supabase.co: NXDOMAIN

$ curl https://xtnaqwvayenfcqzqelmh.supabase.co/auth/v1/health
HTTP 000 — connect failed
```

There is no DNS record, no TCP 443, and `fetch` fails before reaching any
endpoint. Every reported symptom follows from this single fact:

| Symptom | Cause |
|---|---|
| Sign-up fails | `signUp` POSTs to `${supabaseUrl}/auth/v1/signup` — an address that does not resolve |
| No pricing | The whole account body is behind sign-in; no backend means no session |
| No credit purchase | Same gate, plus checkout is separately disabled |

`signUp` itself is fully implemented at `plugin/account-service.cjs:1026`: it
validates the email and an eight-character minimum password, refuses to run
while an OAuth attempt or a password recovery is open, and handles the
verification-required case where Supabase creates a user without returning a
session. It is not broken. It has nothing to talk to.

**Why the test suite did not catch this.** 718 tests exercise code, not
infrastructure. No test reaches the account service over the network, so no test
can fail when the project behind it is absent. This is the gap between "clean
statically" and "runs against reality".

---

## 2. What already exists

Substantially more than the symptoms suggest.

**Authentication** — email/password sign-up and sign-in, email verification and
resend, password reset and recovery, OAuth initiation, session restoration.
Tokens stay in the Electron main process and reach the renderer only through a
narrow IPC bridge.

**Plans and pricing** — four paid tiers plus a $999 Partner lifetime offer, a $10
minimum top-up, plan cards with monthly/annual selection, Partner purchase, credit
top-up quoting with an estimated charge, and auto-reload controls. All of it
reads from a client-side constant in `src/data/subscriptions.ts`, so **pricing
does not require a backend to render**.

That is a statement about rendering only. The server keeps its own catalog in
`billing_private.plan_catalog`, seeded by migration and guarded by an immutability
trigger, so the two must be changed together — see item 6.

**Billing infrastructure** — the SQL layer is the most complete part of the
system: FIFO credit lots, reservations, an append-only ledger, checkout intents,
payment events, auto-reload settings, subscription grant schedules, and atomic
`create_generation_quote` / `reserve_credits` / `capture_credits` /
`release_credits` functions.

---

## 3. What is missing, and what actually blocks it

The payment-provider decision blocks far less than it appears to.

### Blocked by the provider choice — correctly deferred

Only the outermost adapter: provider credentials, hosted-session creation,
provider-side IDs, webhook payload parsing, the recurring-charge mechanism, and
portal/refund API calls. Concretely that is `checkoutHosts` in the packaged
config, the webhook signature format, and `PARTNER_REVERSAL_HANDLING_READY`.

### Not blocked — can and should be finished now

1. **Deploy the backend.** A Supabase project, every migration applied, both edge
   functions deployed, auth settings configured, and `plugin/account-config.json`
   pointing at it. Nothing else on this list can be verified until this exists.

2. **Configure OAuth.** `oauthProviders` is `[]`, so no social buttons render and
   `npm run release:validate-account` fails with *"oauthProviders must enable both
   google and apple"*.

3. **Build the generation gateway data plane.** `/gateway/provider` authenticates
   and then returns a structured 503 because
   `CUSTOMER_GENERATION_GATEWAY_READY = false`
   (`supabase/functions/easyfield-account/index.ts:30`). What is missing is the
   server-side model and price resolver, quote/reserve/capture/release
   orchestration, durable provider-task binding, and crash recovery. This concerns
   the **AI generation providers**, not the payment provider, and is the single
   largest remaining piece.

4. **Seed the server price catalog.** The client renders from
   `src/data/subscriptions.ts` while the server charges from
   `billing_private.plan_catalog`. No amount crosses the edge API, so the client
   cannot detect a mismatch and nothing compares the two.

5. **Show pricing before sign-in.** Someone must currently register, verify an
   email and sign in before learning what anything costs. The data is already
   client-side; only the presentation is gated. This is a product decision, not a
   technical constraint.

6. **Fix the Creator annual price.** Verified across all four tiers:

   | Plan | Monthly | ×12 | Annual | Result |
   |---|---:|---:|---:|---|
   | Starter | $15 | $180 | $144 | saves $36 |
   | **Creator** | **$24** | **$288** | **$300** | **costs $12 more** |
   | Pro | $60 | $720 | $588 | saves $132 |
   | Studio | $129 | $1,548 | $1,188 | saves $360 |

   The source of truth stated it outright: `annualMonthlyEquivalentMoneyMicros` was
   $25 for Creator against a $24 monthly charge. Every other tier saved money;
   Creator's annual plan cost more than paying monthly. The UI clamps the displayed
   saving to zero rather than showing a negative number, and a test encoded that
   clamped outcome, so nothing failed.

   **Resolved** — Creator annual is now **$240** ($20/month equivalent, saving $48),
   shipped in [#37](https://github.com/danik9444/EasyField/pull/37). The clamp
   remains, but the test no longer encodes its output: `tests/subscriptions.test.ts`
   now asserts directly that every plan's annual price is strictly below twelve
   monthly charges, so inverting a tier fails loudly instead of quietly dropping a
   badge.

   Worth recording for the next price change: the server owns a catalog too
   (`billing_private.plan_catalog`), so a price is **not** a client-only edit. It
   took a forward-only migration alongside the constant — deployed migrations are
   never edited in place, and two existing tests deliberately pin the old values as
   proof that history stayed intact.

7. **Prove it end to end with a fake adapter.** A stub checkout adapter allows the
   whole purchase state machine — intent, pending, recovery, reconciliation,
   credit grant — to be tested before any provider exists, and means adopting a
   real provider becomes an adapter swap rather than a first integration.

---

## 4. Where the two analyses disagreed

Recorded because the disagreement is the useful part.

**Found only by direct probing:** that the Supabase project does not exist. The
repository-only analysis correctly identified that sign-up depends on deployed
configuration, but concluded it "cannot prove which configuration was in the
installed artifact or whether the deployed Auth settings are correct." Reading
code cannot answer that question; a DNS lookup can.

**Found only by reading the code closely:** the Creator annual price inversion.
It is invisible from the running application — the UI clamps the saving to zero,
so the screen looks merely unremarkable rather than wrong — and it survives the
test suite because a test encodes the clamped result.

Neither approach would have produced this document alone.

---

## 5. Suggested order

1. Deploy Supabase, apply migrations, deploy edge functions, configure auth and
   OAuth, repoint `plugin/account-config.json`. Everything downstream is
   unverifiable until this is done.
2. Decide the Creator annual price. It is a one-line change and a wrong number on
   a public pricing page is expensive.
3. Move pricing in front of the sign-in wall.
4. Seed the server price catalog and add an equality test against the client
   constants.
5. Build the generation gateway data plane, then flip
   `CUSTOMER_GENERATION_GATEWAY_READY`.
6. Add the fake checkout adapter and drive the purchase state machine through it.
7. When the payment provider is chosen, implement the adapter against that
   interface and populate `checkoutHosts`.

Steps 2 through 6 do not require the payment-provider decision.
