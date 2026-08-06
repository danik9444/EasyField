# Launch readiness

**What is true on 2026-08-06**, at `ac5081c` on `main`, version 1.3.0.

This is the current status document. `RELEASE_READINESS.md` and
`ACCOUNT_READINESS.md` are earlier assessments kept for their reasoning; both
carry corrections at the top and neither should be used to decide anything.

The short version: **the money path is finished and live. Nothing can be sold
yet, and the four things stopping that are not evenly distributed — two of them
are yours, not the code's.**

---

## Verified live

Every figure here was checked against the deployed system on 2026-08-06, not
read from an earlier document.

| | |
|---|---|
| Supabase project | `xtnaqwvayenfcqzqelmh`, eu-central-1, `ACTIVE_HEALTHY` |
| Migrations applied | **22** |
| Edge functions | `easyfield-account` **v2**, `easyfield-admin` v3 |
| Scheduler | **7** `pg_cron` jobs, all `active` |
| Test suite | **851 tests, 850 pass, 1 environment-conditional skip, 0 failures** |
| Website | `easyfield.ai` live, with `/privacy/`, `/terms/`, `/refunds/` |
| Security advisors | 0 ERROR, 0 new WARN |

`ACCOUNT_READINESS.md` opens by asserting this project does not resolve
(`NXDOMAIN`). That was wrong when written and is still wrong; the project is
healthy and has been continuously.

---

## What the money path now does

All of this is applied and running. None of it was true a day ago.

**An abandoned checkout no longer blocks a customer forever.** `expires_at` was
written on every insert and never read, and the only exits from the one-payable
index need evidence the schema refuses to invent — so a customer who closed the
tab was locked out permanently, not for the thirty minutes the timestamp
implied. A checkout that never reached a provider is now closed automatically
after a day, on local evidence that is genuinely local: the insert leaves
`provider_checkout_ref` and `checkout_url` null, and only `open_checkout` ever
writes them. A checkout that *was* opened keeps its slot and enters
`checkouts_awaiting_reconciliation`, because only the provider can say whether
it was paid.

**A renewal grants what was paid for.** `finish_renewal_attempt` wrote five
outcome columns and never advanced the period or granted credits, and could
never enqueue anyway because nothing ever wrote a `saved_payment_methods` row.
Both are fixed, with the period advancing before the grant — `grant_credits`
validates the period against the row it reads, so there is no other order that
works.

**A refund or chargeback takes access back.** `revoke_partner_entitlement` was
correct, idempotent and callerless; a $999 chargeback left lifetime access
active forever. Reversal evidence, a clawback primitive and one reconciliation
entry point now exist, with the account locked before any credit lot (the
opposite order deadlocks against live generation traffic).

**A slow submission no longer orphans paid work.** `accept_submission` refused a
real provider task reference once the reconciler had moved the job to
`submission_ambiguous`, so the reference was discarded — the provider ran the
job and billed us while the customer got nothing.

**A corrupted ledger no longer reads as an empty wallet.** `reserve_credits`
raised `P0001` both for "you have spent your allowance" and for "the account
balance disagrees with the sum of its lots". The second now raises `XX001
data_corrupted`, so the obvious mapping cannot turn a corruption alarm into a
`402 Buy more credits`.

---

## Genuinely blocked, in the order that matters

### 1. Legal documents — yours, and it gates everything commercial

`/privacy/`, `/terms/` and `/refunds/` are published and cross-linked, and the
privacy policy names its sub-processors as GDPR Article 13(1)(e) requires.

**They are drafts and say so on their face.** Every unresolved value is marked,
and `tests/legal-pages.test.mjs` fails if the draft notice is removed. They need
a lawyer, and every bracketed field needs a real value.

This is first because it is not paperwork for afterwards: Paddle, Lemon Squeezy
and Stripe all require ToS, a privacy policy and a refund policy at public URLs
*before* an account is approved. A support address is required alongside them,
and `easyfield.ai` still has no MX record.

### 2. The payment provider — and the decision is already made

`docs/ADR-002:129` states the preference: *"A Merchant of Record is preferred
for global tax registration, calculation, filing and remittance."*

That is not a style choice. **There is no VAT, tax, invoice or receipt handling
anywhere in the schema** — no such columns on `checkout_intents`,
`subscriptions` or `payment_events`. Under a merchant of record the provider
becomes the seller and that gap closes with no code. Under a direct processor it
must be built before the first non-Israeli sale.

What remains after a provider is chosen is smaller than it was but is not
nothing: the checkout contract is bespoke (`verifyHostedCheckoutSession`
requires seven EasyField-shaped fields) and the webhook expects one normalized
event shape with an HMAC of our own. Connecting a provider means writing a shim,
not filling in a form.

### 3. The generation data plane — the largest remaining engineering item

`/gateway/provider` returns 503 unconditionally. Nine
`easyfield_generation_*` RPCs are deployed and nothing calls them.
`generation_price_catalog` has zero rows.

`CUSTOMER_GENERATION_GATEWAY_READY` gates **selling**, not **delivering** —
they are separate code paths and only one reads the constant. Flipping it alone
would let a customer pay, see a balance, watch every Generate button light up,
press one, and get a 503.

See `docs/implementation/generation-data-plane.md`. Its plan does **not** apply
as written — the correction header lists two blockers and five correctness
defects found by review — but it records something useful that was verified on
2026-08-06: the upstream price feed is public and unauthenticated, returns 404
rows over 5 pages, and every sampled row carries a usable `usdPrice`. So
provider cost is a re-verifiable public fact. **The customer markup is not, and
is a margin decision that belongs to a person.**

### 4. Distribution — Apple, and a runtime payload nobody has built

`plugin/runtime-packs.json` is an empty skeleton (`releaseReady: false`, every
architecture target `null`), and `release:validate-runtimes` is the first job in
`release.yml`, so a tag today dies immediately. Seven of eight release secrets
are absent and there are zero tags and zero releases — the workflow has never
run.

Two things about this are commonly underestimated:

- **Two Apple certificates are needed, not one.** Developer ID *Installer* for
  the PKG, and Developer ID *Application* to re-sign every embedded Mach-O
  binary in the runtime packs. The second is not mentioned in
  `docs/RELEASING.md`.
- **FFmpeg must be built, not downloaded.** The Homebrew build is GPL with
  x264/x265/fdk-aac; bundling it in a proprietary installer is the classic trap.
  An LGPL build is required.

Measured on a real librosa environment: 9,133 files and 373 MB *per
architecture*, and of 40 sampled Mach-O binaries, **zero** carried an
`Authority=` — all ad-hoc, which the release validator rejects outright.

Notarization itself is not the gap: it is fully implemented in CI
(`notarytool submit --wait`, stapling, `pkgutil`, `spctl`). Only the credentials
are missing.

---

## Closed since the last assessment

- The site advertised Creator annual at **$300** while the server charged
  **$240**. Fixed, and `tests/website-pricing-parity.test.ts` now ties the
  website table to `src/data/subscriptions.ts` so it cannot drift again.
- Settings promised a per-run upload manifest and a cloud consent gate. Neither
  existed — `uploadManifest` and `consentRequired` were fields on a type nothing
  constructs. The panel now states what the code does.
- The telemetry toggle was inert: the setting was stored and parsed and nothing
  ever read it.
- `website/` was entirely absent from CI. A root `npm audit` cannot see
  `website/pnpm-lock.yaml`, so a clean root report said nothing about the only
  part of the product the public can reach.
- The committed release manifest listed `plugin/account-config.json`, a
  gitignored file, so `release:verify-plugin` failed on a clean clone while
  `npm run verify` rewrote the manifest in place and still exited 0.
- pnpm 11 stopped reading the `pnpm` field in `package.json`, silently dropping
  the minimist security override (#39). It now lives in `pnpm-workspace.yaml`.

---

## Still true and still open

- **Pricing is behind the sign-in wall.** `<PlansSection>` renders only in the
  signed-in branch. Someone must register and verify an email before learning
  what anything costs. This is a product decision, not a technical constraint.
- **Three of twenty tools are mockups.** Culling, B-roll and Captions are
  `execution: 'review-only'` with no implementation anywhere. Captions is the
  worst of the three: Transcribe genuinely works and hands off to it, so the one
  local pipeline that functions ends at a wall. Decide whether to build them or
  remove them from the advertised catalog before launch.
- **There is no onboarding.** A customer installs, restarts Resolve, and sees a
  grid of twenty cards and a Sign in button. Nothing explains that an account is
  needed, that Beat Detection needs a Python runtime, or that Transcribe will
  download up to 3.1 GB. `plugin/beat-detection.cjs:191` points the customer at
  a path inside a repository they do not have.
- **There is no error reporting.** In an Electron plugin hosted by Resolve,
  where the customer's environment cannot be reproduced, the first sign of a
  widespread bug will be refund requests.
- **The device matrix is half done.** Apple silicon is proven — Resolve's own log
  shows the 1.3.0 panel loading. There is zero Intel coverage and no recorded
  result for exact trims, mixed timeline/source FPS, linked A/V, locked tracks,
  HDR/Rec.709 or rollback.
- **The project is on the Supabase free plan.** No PITR, which means no recovery
  target for the billing ledger, and the shared default mail sender. Upgrade
  before taking money.
- **Custom SMTP is not connected.** `mailer_autoconfirm=false`, so confirmation
  is mandatory, and the only two rows in `auth.users` are the owner's address
  and one created directly through admin. No customer confirmation email has
  ever been delivered, and the failure is silent — the API returns 200.

---

## Suggested order

1. Fill in the legal documents, have them reviewed, and open a support address.
   Everything commercial waits behind this.
2. Connect custom SMTP with SPF/DKIM/DMARC on the domain. Until then no one can
   create an account at all.
3. Apply to a merchant of record. Requires 1.
4. Start the Apple enrolment and the runtime-pack build. These have the longest
   lead time and are independent of everything above.
5. Build the generation data plane, then flip
   `CUSTOMER_GENERATION_GATEWAY_READY`.
6. Write the provider shim against the existing seams.

Steps 1, 2 and 4 can start today and do not depend on each other.

---

## How to keep this document honest

Every number above is checkable in one command or one query. When this document
and the system disagree, the system is right and the document is a bug — that
was the failure mode of the two assessments it supersedes, one of which spent
its opening section describing a database outage that was not happening.
