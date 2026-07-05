# Campaign Email Architecture

This extends the existing 15-day summary email pipeline (see `SUMMARY_EMAIL_SETUP.md`)
into a general-purpose campaign system, built for GitHub Issue #25 (15-day
inspirational email). It does not replace the original stats-digest email —
both now run side by side on the same shared infrastructure.

## Directory layout

```
supabase/functions/_shared/email/
  types.ts             ← shared types (unchanged)
  calculator.ts         ← pure stats aggregation (unchanged, reused as-is)
  emailProvider.ts       ← EmailProvider interface + ResendProvider (unchanged, reused as-is)
  dataAccess.ts          ← NEW — Supabase queries extracted so no service duplicates them
  config.ts               ← NEW — all campaign-agnostic config (sender, colors, URLs, socials)
  baseTemplate.ts          ← NEW — shared hero/header/CTA/footer HTML shell
  campaignService.ts        ← NEW — generic engine: run any CampaignDefinition
  campaigns/
    types.ts                 ← NEW — CampaignDefinition contract
    fifteenDayInspiration.ts  ← NEW — Issue #25's actual campaign content
    registry.ts                ← NEW — id → CampaignDefinition lookup
  template.ts             ← original 15-day stats-digest template (unchanged)
  summaryService.ts        ← original service (unchanged behavior — internals now
                              delegate to dataAccess.ts instead of duplicating queries)
  __tests__/
    calculator.test.ts
    summaryService.test.ts
    campaignService.test.ts       ← NEW
    fifteenDayInspiration.test.ts  ← NEW

supabase/functions/
  send-summary-email/index.ts     ← original stub (unchanged)
  send-campaign-email/index.ts    ← NEW stub, generic over campaign id

scripts/
  sendSummaryEmails.ts    ← original CLI (unchanged)
  sendCampaignEmail.ts     ← NEW CLI, takes CAMPAIGN_ID
```

## Why two services instead of one?

`SummaryEmailService` already had passing tests and real (if dry-run-only)
production usage. Rather than risk changing its behavior, its four Supabase
data-access methods were extracted verbatim into `dataAccess.ts` and both
`SummaryEmailService` and the new `CampaignEmailService` now call the same
functions. `SummaryEmailService`'s public API, constructor signature, and
test suite are completely unchanged — this was a pure internal delegation,
verified by re-running its existing tests without modification.

`CampaignEmailService` is the generic version: instead of hardcoding
`EMAIL_TYPE`/`EMAIL_SUBJECT`/`buildEmailHtml`, it takes a `CampaignDefinition`
in its constructor and uses that campaign's own id/subject/builders. The
`user_email_summaries` table already keys duplicate-prevention off a free-text
`email_type` column, so every campaign gets duplicate protection and audit
history for free — no new table or migration was needed.

## Adding a new campaign

1. Create `supabase/functions/_shared/email/campaigns/<name>.ts` exporting a
   `CampaignDefinition`:
   ```typescript
   export const myCampaign: CampaignDefinition = {
     id: 'welcome',            // stored as email_type — must be unique and stable
     periodDays: 0,             // 0/irrelevant for one-off campaigns; N for recurring ones
     subject: 'Welcome to Japam App',
     buildHtml: (ctx) => renderCampaignEmail({ title: '...', hero: {...}, contentHtml: '...', config: ctx.config }),
     buildText: (ctx) => '...',
   };
   ```
2. Add one line to `campaigns/registry.ts`.
3. Run it: `CAMPAIGN_ID=welcome DRY_RUN=true npx tsx scripts/sendCampaignEmail.ts`.

No other file needs to change. `baseTemplate.ts` supplies the hero, brand
mark, CTA button, and footer for every campaign, so new campaigns only ever
write their own content section — they cannot accidentally diverge from the
responsive/table-based layout that renders correctly in Gmail, Apple Mail,
and Outlook.

Suggested future campaigns (not implemented): Welcome, 7-day encouragement,
30-day milestone, 108-day celebration, re-engagement, festival greetings.

## Configuration (`config.ts`)

All campaign-agnostic values are environment-driven — no campaign content
file ever reads `process.env` directly.

| Variable | Default | Purpose |
|---|---|---|
| `EMAIL_FROM_ADDRESS` | `Japam App <noreply@japamapp.com>` | Provider `from` field (existing var) |
| `EMAIL_SENDER_NAME` | parsed from `EMAIL_FROM_ADDRESS` | Display name used in the logo/footer text |
| `APP_URL` | `''` | Existing var; base app URL |
| `EMAIL_CTA_URL` | falls back to `APP_URL` | Overrides just the CTA button destination |
| `EMAIL_LOGO_URL` | `''` | Hosted logo image. Unset → hero's text eyebrow is used instead |
| `EMAIL_HERO_IMAGE_URL` | `''` | Hosted hero photo. Unset → CSS gradient hero (see below) |
| `EMAIL_UNSUBSCRIBE_URL` | `''` | Footer unsubscribe link. **Must be set before any real production send** |
| `EMAIL_COLOR_PRIMARY` / `_PRIMARY_DARK` / `_ACCENT` / `_BACKGROUND` / `_CARD` / `_TEXT` / `_TEXT_MUTED` | Calm/Headspace-style sage+cream palette | Brand colors |
| `EMAIL_SOCIAL_LINKS` | `''` | Comma-separated `Label\|https://url` pairs, rendered in the footer |
| `PERIOD_DAYS` | `15` | Existing var; default period for campaigns that don't set their own |
| `EMAIL_ALLOWLIST` | `''` (no restriction) | Comma-separated addresses. When set, **every** campaign only sends to these — for controlled testing against real production data |

## Unsubscribe & allowlist

Both are enforced in exactly one place: `dataAccess.ts`'s `getActiveUsersInPeriod` —
the single function every service (`SummaryEmailService` and
`CampaignEmailService` alike) calls to find who's eligible this run. Neither
campaign code nor the per-user loop needs to know either exists.

- **Unsubscribe:** `getUnsubscribedUserIds()` reads `user_email_preferences`
  (migration `20260705_add_user_email_preferences.sql`) for every user with a
  non-null `unsubscribed_at`, and those users are filtered out before any
  stats are computed or any email is rendered. This is its own table, not a
  column on the existing `user_profiles` — see the migration's comment for
  why: `user_profiles`'s RLS policies currently allow any `anon`/
  `authenticated` client to update *any* row, and a compliance-critical
  opt-out flag must not inherit that. RLS on the new table is enabled with no
  public policies, mirroring `user_email_summaries`; only the service role
  (used by every email script) can read or write it. **No app or web
  unsubscribe page exists yet** — until one does, rows are written by
  operators/service-role only. Building that page is the next step before
  any real send.
- **Allowlist:** `EMAIL_ALLOWLIST` (comma-separated addresses) is parsed via
  `config.ts`'s `parseAllowlist()` and applied as a second filter in the same
  function. Unset (the default) means no restriction — identical to behavior
  before this existed.

## Production environment validation

`config.ts`'s `assertProductionReady()` is called from both CLI scripts
immediately before any real (non-`DRY_RUN`) send, and throws with every
problem found (not just the first) if any of the following are missing or
wrong:

- `RESEND_API_KEY` unset.
- `EMAIL_FROM_ADDRESS` unset (would silently fall back to the built-in
  `noreply@japamapp.com` default — a domain that is not registered) or still
  literally containing `japamapp.com`.
- `EMAIL_UNSUBSCRIBE_URL` unset.
- `EXPO_PUBLIC_SUPABASE_URL`/`SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` unset.

`DRY_RUN=true` (the default) skips this check entirely — dry-run and testing
workflows are unaffected.

## DNS requirements (Resend)

Before `EMAIL_FROM_ADDRESS` can point at a real domain, that domain must be
added and verified in the Resend dashboard. Resend generates the exact
records to add — you don't hand-write SPF/DKIM yourself:

1. **Add the domain** in the Resend dashboard → Domains. Resend generates a
   DKIM TXT record (the public key used to verify mail claiming to be from
   your domain) and an SPF setup for you automatically.
2. **Add a send subdomain** (e.g. `send.yourdomain.com`) — Resend asks for a
   TXT record on it (used as the Envelope-From/return-path domain) and an MX
   record on the same subdomain for bounce processing.
3. **DMARC** is not auto-generated the same way — add a `_dmarc.yourdomain.com`
   TXT record yourself (e.g. `v=DMARC1; p=none; rua=mailto:you@yourdomain.com`
   to start in monitor-only mode). Resend supports DMARC alignment via both
   SPF and DKIM, with strict alignment on DKIM and relaxed on SPF.
4. **Wait for verification** — Resend rechecks for up to 72 hours; DNS
   propagation is typically under 24 hours. The domain shows "Verified" once
   detected, "Failure" if it times out.

This project's specific blocker: `japamapp.com` (the domain baked into the
code's default `EMAIL_FROM_ADDRESS`) is confirmed **NXDOMAIN** — not
registered at all. A real, owned domain must be chosen, registered, and
taken through the steps above before `EMAIL_FROM_ADDRESS` can point at it.
`assertProductionReady()` (above) blocks a real send until this var is set to
something other than that default.

Sources: [Resend — Managing Domains](https://resend.com/docs/dashboard/domains/introduction), [How to set up SPF, DKIM and DMARC for Resend](https://dmarc.wiki/resend).

## Hero banner: image vs. coded gradient

The task asked for "a large premium hero image." No image-generation or
photo-hosting capability was available in this session, so `baseTemplate.ts`
supports both, and prefers a real photo automatically once one exists:

- If `EMAIL_HERO_IMAGE_URL` is set, the hero renders that photo as a CSS
  background (`background-image`, cover/center).
- If unset (today's default), the hero renders a CSS gradient
  (sage → deep green) with the headline and a lotus/sunrise accent line
  overlaid — this is not a placeholder hack, it's also the more reliable
  choice for email specifically: Gmail and Outlook both block remote images
  by default until the recipient clicks "show images," so a gradient hero
  guarantees the email never looks broken/empty on first open, with or
  without a photo configured later.

To add a real photo: host it somewhere public (Vercel `/public`, Supabase
Storage, S3, etc.) and set `EMAIL_HERO_IMAGE_URL`. No code change needed.

## What's intentionally not done here

Per the task's scope ("planning and implementation work only" — do not
deploy, publish an OTA, or modify `main`), the following remain **not**
implemented, matching the "future"/prerequisite items already tracked for
this feature:

- **No scheduling.** No cron job, GitHub Action, or Supabase Cron entry was
  added — sending still requires manually running
  `scripts/sendCampaignEmail.ts`, exactly like the existing summary email.
- **No unsubscribe web page.** The database side is done —
  `user_email_preferences`/`unsubscribed_at` exists and is enforced in the
  shared send path — but there's no page for a user to actually reach that
  table (e.g. a `/unsubscribe?token=...` route). Until one exists, opt-outs
  can only be recorded by an operator directly. Building that page is the
  next concrete step before any real send.
- **No real hosted hero photo or logo** — see above; both are one env var
  away once assets exist.
- **`auth.admin.listUsers()` is still capped at one page (1000 users)** —
  inherited from the original `SummaryEmailService`/now shared via
  `dataAccess.ts`; fine at current scale, worth revisiting before a much
  larger user base.

## Testing

`campaignService.test.ts` and `fifteenDayInspiration.test.ts` follow the
exact same fake-subclass pattern as the existing `summaryService.test.ts` —
no Supabase query-builder mocking, just protected-method overrides. Run
alongside everything else:

```bash
npm test
```
