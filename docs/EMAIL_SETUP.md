# Email delivery

## Where it stands

Email works. Sign-up sends a confirmation and the account cannot sign in until
it is clicked — verified live on 2026-07-29:

```
mail.send · from noreply@mail.app.supabase.io · type: confirmation · status 200
```

That sender is Supabase's **shared default**. It is fine for testing and wrong
for customers, for two reasons that both fail quietly:

- **Rate limit.** The shared service allows only a handful of emails per hour on
  the free tier. Past that, sign-ups still return `200` and no email arrives.
  The customer sees "check your email" and waits for something that was never
  sent.
- **Deliverability.** Mail from `mail.app.supabase.io` is not authenticated for
  your domain, so a meaningful share lands in spam.

Neither shows up as an error anywhere.

## Connecting your own SMTP

This is a Dashboard setting. It cannot be scripted from here: there is no
`auth.config` table, the value lives in GoTrue's environment, and the tooling
available in this repo has no management-API token. It also needs a provider
credential, which should be created by you and pasted directly rather than
passing through anything else.

**Dashboard → Project Settings → Authentication → SMTP Settings → Enable custom SMTP.**

Any provider works. Resend is the least setup for a small sender; SendGrid,
Postmark and Mailgun are equivalent for this purpose.

| Field | Value |
|---|---|
| Sender email | `noreply@` your domain — must be a domain you can add DNS records to |
| Sender name | `EasyField` |
| Host | your provider's SMTP host, e.g. `smtp.resend.com` |
| Port | `465` (implicit TLS) or `587` (STARTTLS) |
| Username | as issued by the provider — `resend` for Resend |
| Password | the provider's API key |

**Verify the sending domain with the provider first** — SPF, DKIM and DMARC
records on your DNS. Without them the mail is authenticated no better than the
shared sender and the deliverability problem is unchanged. Every provider gives
the exact records to add.

Then raise **Authentication → Rate Limits → Emails per hour** past the shared
default, or the provider's capacity will not be used.

## Also worth setting while you are there

- **Leaked-password protection** — Authentication → Sign In / Providers →
  Email. Checks new passwords against HaveIBeenPwned. It is **gated to the Pro
  plan**; this project is on Free. The toggle is not disabled in the UI, which
  makes it look available — but saving it returns `402 Payment Required` from
  `PATCH /platform/auth/<ref>/config`, and the setting does not persist.
  Turning it on is a plan change, not a configuration change. **Decided on
  2026-07-29: stay on Free.** See `docs/LAUNCH_READINESS.md` for the approaches
  that were investigated and rejected, so they are not re-proposed.

  While it is unavailable the minimum password length carries the load: it was
  raised from 6 to **12** and is enforced by the project. A signup below it is
  rejected with `weak_password` before an account exists. The plugin mirrors the
  number (`MIN_PASSWORD_LENGTH` in `src/core/account.ts`) only so it can say so
  without a round trip — the server remains the authority. Note the honest
  limit: length does not detect a long password that is already breached.

  Sign-in deliberately does **not** apply the minimum. It is a policy for
  passwords being set; enforcing it at sign-in would lock out every account
  created before the policy was raised.

## Confirmation returns the customer to the app

Sign-up and resend now bind the emailed link back to the running plugin
(`plugin/account-service.cjs`), the same way password recovery and OAuth
already did. Clicking "Confirm your email" lands on the loopback callback,
the PKCE code is exchanged, and the customer is **signed in** rather than
left on a web page to come back and sign in by hand.

Three things are worth knowing about how it behaves:

- **The window is thirty minutes**, not the five that OAuth and recovery use.
  Those never leave the flow; email does — the inbox may be on another device.
- **Arriving with no open attempt is reported as success.** Supabase verifies
  the token and marks the address confirmed *before* it redirects, so if the
  app restarted or the link was opened twice, the account is confirmed and
  only the automatic sign-in was lost. The page says so. Reporting failure
  there would be telling someone their confirmation did not work when it did.
- **The session must belong to the address the attempt was opened for.**
  Verified against `/auth/v1/user` before it is accepted, so a link issued for
  one account cannot establish a session for another.

No Dashboard change is needed for this. Supabase already permits loopback
redirects — verified against the live project: a foreign `redirect_to` is
refused and falls back to `site_url`, while
`http://127.0.0.1:18832/auth/confirm` is honoured with the code appended.
`supabase/config.toml` declares all three callbacks so the intent is not
Dashboard-only state.

The whole chain was exercised end to end against the deployed project:
sign-up with PKCE returned a `pkce_`-prefixed confirmation token, `/auth/v1/verify`
redirected to the loopback URL with a `code`, and exchanging that code with the
verifier returned a session with `email_confirmed_at` set.

A build with no loopback callback configured sends no `redirect_to` at all and
behaves exactly as it did before, so this is additive rather than a new
requirement.

## site_url now points at the live site

The Site URL is `https://easyfield.ai` — set on 2026-07-29, once `website/` was
deployed and the domain resolved. Every refused or fallback redirect lands
there, including a confirmation click made while the plugin is not running.

Verified against GoTrue rather than the Dashboard:

```
GET /auth/v1/verify?token=…&redirect_to=https://attacker.example.com/steal
303  location: https://easyfield.ai#error=access_denied&…
```

The fallback moved, and the foreign target is still refused.
