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

- **Leaked-password protection** — Authentication → Policies. Checks new
  passwords against HaveIBeenPwned. One toggle, same reason it cannot be
  scripted here.
- **Redirect URLs** — Authentication → URL Configuration. See
  `docs/ACCOUNT_SERVICE_DEPLOYMENT.md`; the loopback callbacks carry a
  per-attempt nonce and need the `**` wildcard form, or OAuth and password
  recovery both fail silently.

## A known gap, and why it is not a one-line fix

The plugin sends no `redirect_to` on sign-up or resend
(`plugin/account-service.cjs:1046`, `:1313`), unlike password recovery
(`:1115`) and OAuth (`:1352`). So a customer who clicks "Confirm your email"
lands on the Supabase Site URL rather than back in the app, and has to return to
EasyField and sign in by hand.

Adding `redirect_to` alone would make this **worse**. The loopback server has
handlers for `/auth/callback` (OAuth) and `/auth/recovery` only, and the OAuth
handler requires a pending attempt bound by nonce — a confirmation link carries
no such attempt, so it would be rejected with `invalid account callback`. Today
the customer at least lands somewhere that works.

Closing it properly means a confirmation flow of its own: a pending sign-up
attempt with its own nonce, a `/auth/confirm` route, the PKCE exchange, and a
renderer notification — the same shape as recovery. That is a real piece of
work on the most security-sensitive boundary in the plugin, and it should be
built against a real email round-trip, which means doing it after SMTP is
connected rather than before.
