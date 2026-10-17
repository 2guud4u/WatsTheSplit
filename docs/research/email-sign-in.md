# Research: sending the email for code-based sign-in

Checked: 2026-10-16 (UTC). Pricing and limits change often, so re-check them before you commit. Entries marked **UNVERIFIED** could not be confirmed from a primary source.

Context: the app runs on a home server behind a Cloudflare Tunnel (public URL `https://jiathe.dev/watsthesplit`). `jiathe.dev` DNS is already on Cloudflare, so adding TXT/MX/CNAME records is easy — Cloudflare's DNS dashboard supports adding records at any time. [Cloudflare DNS records](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/)

---

## 1. Transactional email services

### 1.1 Per-provider findings

**Resend**
- Free tier: 3,000 emails/month, 100 emails/day. Whether a credit card is required at signup: **UNVERIFIED**. [Resend quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits), [free-tier announcement](https://resend.com/blog/new-free-tier)
- Send via REST API key or SMTP (there is an official Nodemailer/SMTP guide). [Resend SMTP docs](https://resend.com/docs/send-with-nodemailer-smtp)
- The built-in `resend.dev` sender (`onboarding@resend.dev`) is **test-only**: it can only send to the email address on your own Resend account. Sending to real users requires a verified domain — no usable shared-domain path. [Resend 403 knowledge-base entry](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain)
- Domain verification records (per the Cloudflare guide): MX `send` → `feedback-smtp.<region>.amazonses.com`, TXT `send` → `v=spf1 include:amazonses.com ~all`, TXT `resend._domainkey` → DKIM public key. Recommended to use a subdomain (e.g. `mail.jiathe.dev`). [Resend Cloudflare guide](https://resend.com/docs/guides/dns/cloudflare)
- Because the domain is already on Cloudflare, Resend's "Sign in to Cloudflare" Domain Connect button can add all records automatically. [Resend Cloudflare guide](https://resend.com/docs/guides/dns/cloudflare)

**AWS SES**
- No real free tier anymore. The old 3,000-messages/month-for-12-months free tier ended for new customers on 2026-07-21. New AWS accounts get up to $200 of Free Tier credits (6-month free plan window). [SES pricing plans announcement](https://aws.amazon.com/blogs/messaging-and-targeting/introducing-amazon-simple-email-service-ses-pricing-plans), [SES pricing](https://aws.amazon.com/ses/pricing/)
- Price: $0.16/1,000 emails on the default Essentials plan, or $0.10/1,000 on à-la-carte pricing. [SES pricing](https://aws.amazon.com/ses/pricing/)
- Send via SES API (AWS credentials) or SMTP credentials. [SES pricing](https://aws.amazon.com/ses/pricing/)
- **Major friction: the sandbox.** New accounts can only send *to* verified addresses, max 200 messages/day, 1 msg/s, until a production-access request is manually approved (initial response within 96 hours). [SES sandbox doc](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
- Domain verification: Easy DKIM via DNS records SES gives you (Route 53 can auto-create; for Cloudflare you paste them yourself), 2048-bit keys. [Easy DKIM doc](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy.html)
- Cheapest at volume but worst day-one experience: AWS account + sandbox approval wait.

**SendGrid (Twilio)**
- Free tier **no longer exists as a permanent plan** for new accounts: since 2025-03-25 new accounts get a **60-day trial** capped at 100 emails/day, then sending stops unless you pay (Essentials from $19.95/mo). [SendGrid trial overview](https://support.sendgrid.com/hc/en-us/articles/35270136965403-Overview-of-60-Day-Free-Trial-Plans-for-New-SendGrid-Accounts), [SendGrid pricing](https://www.twilio.com/en-us/products/email-api/pricing)
- Send via Web API (API key) or SMTP. [SendGrid trial overview](https://support.sendgrid.com/hc/en-us/articles/35270136965403-Overview-of-60-Day-Free-Trial-Plans-for-New-SendGrid-Accounts)
- A From address must be a verified sender identity: either Domain Authentication (DNS records — CNAMEs for DKIM/link branding) or Single Sender Verification (click a link in a confirmation email; no DNS changes, but mail is then DKIM-signed by sendgrid.net, not your domain — hurts alignment and shows "via sendgrid.net"). [SendGrid sender identity docs](https://www.twilio.com/docs/sendgrid/for-developers/sending-email/sender-identity), [SendGrid API: authenticate a domain](https://www.twilio.com/docs/sendgrid/api-reference/domain-authentication/authenticate-a-domain)
- Verdict: dead end for a hobby app — the trial expires.

**Mailgun (Sinch)**
- Free plan: 100 messages/day, no credit card, 1 custom domain, 1-day log retention. [Mailgun free plan](https://help.mailgun.com/hc/en-us/articles/203068914-What-does-the-Free-plan-offer)
- Send via HTTP API or SMTP credentials. [Mailgun free plan](https://help.mailgun.com/hc/en-us/articles/203068914-What-does-the-Free-plan-offer)
- The sandbox domain (`sandboxXXX.mailgun.org`) can only send to up to 5 manually "Authorized Recipients" who click a verification link — so it cannot deliver codes to arbitrary users. [Mailgun Authorized Recipients](https://help.mailgun.com/hc/en-us/articles/217531258-Authorized-Recipients)
- Ambiguity: the Free-plan page says 1 custom domain can be "added, verified, and utilized" with no card, but the Authorized Recipients page says free accounts *without* card details are restricted to Authorized Recipients. Whether a no-card free account can actually send to arbitrary users from a verified custom domain is **UNVERIFIED** — assume card-on-file may be required.
- Custom domain needs DNS records (DKIM TXT, SPF TXT, optional MX/CNAME per dashboard). [Mailgun free plan](https://help.mailgun.com/hc/en-us/articles/203068914-What-does-the-Free-plan-offer)

**Postmark**
- Developer plan: 100 emails/month, no expiry — a permanent free tier but very low volume. Paid starts at $15/mo for 10k emails. [Postmark pricing FAQ](https://postmarkapp.com/support/article/1285-pricing-billing-faq)
- Send via API token or SMTP. [Postmark getting started](https://postmarkapp.com/support/article/1002-getting-started-with-postmark)
- Every From address needs a Sender Signature (single-address email verification) or a Verified Domain (DKIM TXT + custom Return-Path CNAME in DNS). No shared Postmark domain for production mail. [Postmark getting started](https://postmarkapp.com/support/article/1002-getting-started-with-postmark), [Postmark domain verification](https://postmarkapp.com/support/article/how-do-i-verify-a-domain)
- Verdict: 100/mo is too small for anything beyond personal testing.

**Brevo (ex-Sendinblue)**
- Free plan: 300 emails/day (≈9,000/month), no time limit, transactional SMTP + REST API included. [Brevo email API page](https://www.brevo.com/features/email-api/), [Brevo free-plan FAQ](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan)
- Domain authentication (Brevo code TXT, DKIM TXT, DMARC) is documented as needed for the sender domain; whether the free plan will technically send without it is **UNVERIFIED** — third-party sources say DKIM has been enforced since Feb 2024, and unauthenticated sending would fail Gmail's requirements anyway. [Brevo domain auth FAQ](https://help.brevo.com/hc/en-us/articles/17286219877778-FAQs-About-domain-authentication-Brevo-code-DKIM-DMARC), [Brevo sender-requirements guide](https://help.brevo.com/hc/en-us/articles/14925263522578-Comply-with-Gmail-Yahoo-and-Microsoft-s-requirements-for-email-senders)
- Highest free daily volume of the group.

### 1.2 Comparison table

| Provider | Free tier | API / SMTP | Shared domain for real users | DNS needed for own domain | Friction notes |
|---|---|---|---|---|---|
| [Resend](https://resend.com/pricing) | 3,000/mo, 100/day | Both | No — `resend.dev` only sends to yourself | MX+TXT (SPF) + TXT DKIM; auto-setup via Cloudflare Domain Connect | Lowest DNS friction (one-click with Cloudflare) |
| [AWS SES](https://aws.amazon.com/ses/pricing/) | No ($200 new-account credits) | Both | No | DKIM CNAMEs via Easy DKIM | Sandbox: manual production-access review, up to 96 h; needs AWS account |
| [SendGrid](https://www.twilio.com/en-us/products/email-api/pricing) | 60-day trial only, 100/day | Both | No | Domain auth CNAMEs, or Single Sender (email click, weak deliverability) | Trial expires — not viable free |
| [Mailgun](https://help.mailgun.com/hc/en-us/articles/203068914-What-does-the-Free-plan-offer) | 100/day | Both | No — sandbox limited to 5 authorized recipients | TXT DKIM + SPF | No-card arbitrary sending **UNVERIFIED** |
| [Postmark](https://postmarkapp.com/support/article/1285-pricing-billing-faq) | 100/month | Both | No | DKIM TXT + Return-Path CNAME | Volume too small |
| [Brevo](https://www.brevo.com/features/email-api/) | 300/day (~9k/mo) | Both | No | TXT Brevo code + DKIM + DMARC | Most free volume; send-without-DNS **UNVERIFIED** |

---

## 2. Plain SMTP from a personal mailbox (Gmail app password)

- **Consumer Gmail: still works.** Google's "Sign in with app passwords" page is live and app passwords remain available for accounts with 2-Step Verification, though Google says they "aren't recommended". [Google app passwords](https://support.google.com/accounts/answer/185833)
- **Google Workspace: mostly dead.** Since 2025-05-01, Workspace accounts can't authenticate third-party apps with username+password; OAuth is required. (App passwords are separate and admin-dependent — **UNVERIFIED** whether they'd work for a Workspace account.) [Workspace less-secure-apps retirement](https://workspaceupdates.googleblog.com/2023/09/winding-down-google-sync-and-less-secure-apps-support.html), [Workspace SMTP/app doc](https://knowledge.workspace.google.com/admin/gmail/send-email-from-a-printer-scanner-or-app)
- **Limits:** consumer Gmail caps ~500 emails/day (and 500 recipients/message). Plenty for a hobby app. [Gmail sending limits](https://support.google.com/mail/answer/22839)
- Practical shape: `smtp.gmail.com:465` (TLS) or `:587` (STARTTLS), login = Gmail address, password = 16-char app password. The From address will be your Gmail address (or a configured send-as alias); SPF/DKIM/DMARC are Google's, so no DNS work and generally good deliverability — but the From won't be `@jiathe.dev` and the quota/lockout risk lives on a personal account. [Google app passwords](https://support.google.com/accounts/answer/185833), [Gmail sending limits](https://support.google.com/mail/answer/22839)
- Verdict: viable zero-dependency-of-external-service fallback; weaker branding, and Google actively discourages the mechanism.

## 3. Deliverability realities from a home server

- **Sending directly from a residential IP is effectively off the table.** Most ISPs block outbound TCP/25, and even where it isn't blocked, residential/dynamic ranges are listed in the Spamhaus Policy Blocklist — a dataset of "end-user IP address ranges from which email should never be sent directly to the final destination." [Spamhaus PBL](https://www.spamhaus.org/blocklists/policy-blocklist), [Comcast port-25 block example](https://forums.xfinity.com/conversations/email/residential-use-of-home-mail-server-blocked-on-port-25/64b93c692674ac1b6b90dc77), [cPanel: why port 25 is blocked](https://support.cpanel.net/hc/en-us/articles/360041074753-Why-is-port-25-blocked)
- PTR/forward-confirmed reverse DNS is required by Gmail for *all* senders; residential IPs can't get meaningful rDNS. [Gmail sender guidelines](https://support.google.com/mail/answer/81126)
- So "send email" from this box always means **SMTP submission** (port 587/465, authenticated) to a relay — Gmail's servers or a transactional provider's — never direct-to-MX on port 25.
- What actually lands in the inbox via a provider:
  - Gmail requires *all* senders to have **SPF or DKIM** plus valid forward/reverse DNS and TLS; senders of 5,000+/day additionally need SPF **and** DKIM **and** DMARC. [Gmail sender guidelines](https://support.google.com/mail/answer/81126)
  - In practice, set up SPF+DKIM+DMARC on a subdomain (`mail.jiathe.dev`) whatever the volume — every provider above gives you the records.
  - Keep spam-complaint rate under 0.3% in Google Postmaster Tools. [Gmail sender guidelines](https://support.google.com/mail/answer/81126)
- The Cloudflare Tunnel is irrelevant to sending — it only serves inbound HTTP. Outbound SMTP/API calls from the box are unaffected by it. ([INFERENCE] — tunnels carry ingress; outbound connections go direct.)

## 4. The email-code sign-in flow — conventions

- **No formal standard** exists for emailed login codes (RFC 6238/TOTP covers authenticator apps, not emailed codes). Implementation guidance comes from OWASP and the defaults of existing auth systems.
- **OWASP recommendations for OTPs:** short TTL; single-use; strict attempt limits; invalidate on successful verification; never log the value; don't store long-term plaintext; generate with a CSPRNG; prefer 8+ digit codes where usable; on resend, generate a new code overwriting the old. Hashing is still recommended — not for brute-force resistance (a ~10^6 keyspace is trivially cracked offline) but to avoid leakage via logs/backups and limit exposure during the validity window. [OWASP MFA Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)
- **Observed defaults in production auth systems:**
  - better-auth `email-otp`: 6-digit OTP, `expiresIn` default **300 s (5 min)**, `allowedAttempts` default **3**, resend "rotates" (new code, old invalidated), storage `plain` by default with `hashed`/`encrypted` options. [better-auth email-otp docs](https://www.better-auth.com/docs/plugins/email-otp)
  - Supabase: magic links and email OTPs share an implementation; default expiry **1 hour** (configurable, >24 h discouraged), one request per **60 s** cooldown, magic links single-use, first sign-in auto-registers the user. [Supabase passwordless docs](https://supabase.com/docs/guides/auth/passwordless-login/auth-magic-link)
- **Link vs code:** the emailed link usually *is* a login link carrying a token — clicking it creates a session directly (Supabase's default), while the code exists for the cross-device case (email opened on phone, browser on laptop) where a link can't transfer a session. Both are the same underlying token type in Supabase. Sending both a link and a code in one email is the common pattern; giving them equal power is typical, but note a link that auto-signs-in is phishable in a way a typed code is not. [Supabase passwordless docs](https://supabase.com/docs/guides/auth/passwordless-login/auth-magic-link)
- **Rate limiting happens at both ends:** request side (Supabase's 60 s/email cooldown) and verify side (better-auth's 3 attempts then invalidate). Also rate-limit by IP — the request endpoint is an unauthenticated way to make your server send email to arbitrary addresses, i.e. a free spam relay for someone else's address list. [Supabase passwordless docs](https://supabase.com/docs/guides/auth/passwordless-login/auth-magic-link), [better-auth email-otp docs](https://www.better-auth.com/docs/plugins/email-otp)
- **On the planned 4-char code:** 36⁴ ≈ 1.68 M possibilities (~26⁴ ≈ 457 k if letters-only) — smaller than the 6-digit (~1 M) and 8-digit codes OWASP points to. Workable only with strict attempt limits (≈3 tries/code then force a new request) plus the request-side cooldown. [OWASP MFA Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)
- **Storage:** store a hash (or HMAC) of the code + expiry + attempt counter, keyed by email; delete on success. Both systems above do something equivalent. [OWASP MFA Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)

## 5. Sending from Bun

- **No dependency needed for HTTP APIs.** Resend/Brevo/etc. are a `fetch` to their REST endpoint — the lightest path in Bun. [Resend Bun docs](https://resend.com/docs/send-with-bun)
- **Nodemailer works under Bun** (Bun implements `node:net`/`node:tls`), and Resend even documents a Nodemailer-SMTP path. One caveat: pin ≥ 8.0.5 — versions before that have CVE-2026-82853 (SMTP command injection via unsanitized `name` in EHLO). [Nodemailer SMTP docs](https://nodemailer.com/smtp), [Resend Nodemailer guide](https://resend.com/docs/send-with-nodemailer-smtp), [CVE-2026-82853](https://www.cve.org/CVERecord?id=CVE-2026-82853)
- **Raw socket is feasible:** `Bun.connect` supports `tls: true` for implicit-TLS sockets (port 465) and STARTTLS could be layered on top — but hand-rolling SMTP auth (EHLO/AUTH/base64/UTF-8 headers) is ~100+ lines for no benefit over `fetch`. [Bun TCP docs](https://bun.sh/docs/runtime/networking/tcp), [Bun.connect reference](https://bun.sh/reference/bun/connect)

## Bottom line

- **Recommended: Resend + Cloudflare Domain Connect.** Sign up → add `mail.jiathe.dev` → click "Sign in to Cloudflare" → DNS records (MX/SPF TXT + DKIM TXT) are written automatically → call the REST API with `fetch`. Free tier (3,000/mo, 100/day) dwarfs this app's needs; no sandbox review, no expiry. [Resend Cloudflare guide](https://resend.com/docs/guides/dns/cloudflare), [Resend quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits)
- **Runner-up: Brevo** (300/day forever, more headroom) if Resend's 100/day cap ever matters.
- **Zero-new-account fallback: Gmail app password + Nodemailer (≥8.0.5)** — works today for consumer Gmail, 500/day cap, but From = gmail.com address and Google discourages it.
- **Avoid:** SendGrid (trial expires in 60 days), SES (paid + sandbox approval wait), Postmark (100/mo), Mailgun (authorized-recipient ambiguity), and any idea of sending directly from the home IP.
- Also add a DMARC TXT record on the sending subdomain (`_dmarc.mail.jiathe.dev`, `v=DMARC1; p=none` suffices) — Gmail requires it for bulk senders and recommends it for everyone. [Gmail sender guidelines](https://support.google.com/mail/answer/81126)
- For the flow itself: bind the code to email + expiry (~10 min) + ≤3 attempts + single use, store it hashed, cooldown ~60 s per email and rate-limit per IP, and treat the emailed link as an equivalent-capability login token only if you want one-click sign-in (Supabase's model); a code-only email is slightly more phishing-resistant.

---

## Sources

- https://resend.com/pricing , https://resend.com/blog/new-free-tier , https://resend.com/docs/knowledge-base/account-quotas-and-limits (2026-10-16)
- https://resend.com/docs/knowledge-base/403-error-resend-dev-domain (2026-10-16)
- https://resend.com/docs/dashboard/domains/introduction , https://resend.com/docs/guides/dns/cloudflare (2026-10-16)
- https://resend.com/docs/send-with-nodemailer-smtp , https://resend.com/docs/send-with-bun (2026-10-16)
- https://aws.amazon.com/ses/pricing/ (2026-10-16)
- https://aws.amazon.com/blogs/messaging-and-targeting/introducing-amazon-simple-email-service-ses-pricing-plans (2026-10-16)
- https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html , https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy.html (2026-10-16)
- https://support.sendgrid.com/hc/en-us/articles/35270136965403-Overview-of-60-Day-Free-Trial-Plans-for-New-SendGrid-Accounts (2026-10-16)
- https://www.twilio.com/en-us/products/email-api/pricing , https://www.twilio.com/docs/sendgrid/for-developers/sending-email/sender-identity , https://www.twilio.com/docs/sendgrid/api-reference/domain-authentication/authenticate-a-domain (2026-10-16)
- https://help.mailgun.com/hc/en-us/articles/203068914-What-does-the-Free-plan-offer , https://help.mailgun.com/hc/en-us/articles/217531258-Authorized-Recipients (2026-10-16)
- https://postmarkapp.com/support/article/1285-pricing-billing-faq , https://postmarkapp.com/support/article/1002-getting-started-with-postmark , https://postmarkapp.com/support/article/how-do-i-verify-a-domain (2026-10-16)
- https://www.brevo.com/features/email-api/ , https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan , https://help.brevo.com/hc/en-us/articles/17286219877778-FAQs-About-domain-authentication-Brevo-code-DKIM-DMARC , https://help.brevo.com/hc/en-us/articles/14925263522578-Comply-with-Gmail-Yahoo-and-Microsoft-s-requirements-for-email-senders (2026-10-16)
- https://support.google.com/accounts/answer/185833 , https://support.google.com/mail/answer/22839 , https://support.google.com/mail/answer/81126 (2026-10-16)
- https://workspaceupdates.googleblog.com/2023/09/winding-down-google-sync-and-less-secure-apps-support.html , https://knowledge.workspace.google.com/admin/gmail/send-email-from-a-printer-scanner-or-app , https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace (2026-10-16)
- https://www.spamhaus.org/blocklists/policy-blocklist , https://forums.xfinity.com/conversations/email/residential-use-of-home-mail-server-blocked-on-port-25/64b93c692674ac1b6b90dc77 , https://support.cpanel.net/hc/en-us/articles/360041074753-Why-is-port-25-blocked (2026-10-16)
- https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html (2026-10-16)
- https://www.better-auth.com/docs/plugins/email-otp (2026-10-16)
- https://supabase.com/docs/guides/auth/passwordless-login/auth-magic-link (2026-10-16)
- https://bun.sh/docs/runtime/networking/tcp , https://bun.sh/reference/bun/connect , https://nodemailer.com/smtp , https://www.cve.org/CVERecord?id=CVE-2026-82853 (2026-10-16)
- https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/ (linked, not re-read)
